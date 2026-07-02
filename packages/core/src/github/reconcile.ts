/**
 * Shared GitHub reconciliation algorithm (docs/01-system-specification.md §5.7):
 *
 *   "on each relevant webhook (or on the scheduled fallback), fetch authoritative GitHub state,
 *    compare against the database record, and either advance the workflow, mark it
 *    human_required on irreconcilable divergence, or no-op when already consistent."
 *
 * This function takes an *already-fetched* ObservedPullRequestState (the caller — a webhook
 * inbox handler or the github-reconciliation scheduled task — is responsible for calling
 * GitHubClient first) and never imports a provider SDK, keeping Orchestrator Core
 * provider-SDK-free. Both the webhook-triggered path and the scheduled-fallback path
 * (packages/triggerdev/src/tasks/github-reconciliation.ts) call this same function so they can
 * never diverge in behavior.
 *
 * Multi-step catch-up (code-review HIGH-2): a single call re-evaluates the branch chain in a
 * bounded loop (capped at MAX_RECONCILE_STEPS, mirroring the clarification-round/review-cycle
 * circuit-breaker convention elsewhere in the codebase) after each executed action, so a missed
 * intermediate webhook (e.g. `ci_running` never arrived but CI is already terminal by the time we
 * observe it) doesn't strand the feature run — `PR_OPENED` + `observed.ciStatus === 'passed'` now
 * applies RecordPrOpenedHandler-equivalent-skip then RecordCiRunningHandler then
 * RecordCiPassedHandler in the same call instead of requiring two separate reconcile passes. HIGH-2
 * also runs `syncPullRequestObservedState` a second time after the loop so a `pull_requests` row
 * created mid-loop (by the CODE_PUSHED -> pr_opened branch below) still ends up with real observed
 * `mergeable`/`blockingLabels`/`conversationsResolved`, not `insertPullRequestRow`'s defaults.
 *
 * Fix-cycle re-entry (code-review HIGH-1): the `CODE_PUSHED -> pr_opened` branch is not gated on
 * whether a `pull_requests` row already exists — a fix-cycle re-push
 * (`changes_requested -> fixing -> code_pushed`) reuses the *same* GitHub PR, so a prior PR-open
 * having already created the row must not block reconciliation from advancing again. Every
 * idempotency key in this module includes `observed.headSha`, not just `featureRunId`/`prNumber`,
 * so a second pass through the same PR after a new commit gets a fresh key and actually executes,
 * while repeated deliveries for the *same* commit still collapse to the same key (true idempotency
 * preserved) — the same pattern `RecordCodePushedCommand` already uses
 * (`record-code-pushed:{featureRunId}:{commitSha}`).
 */

import { FeatureExecutionState, UserRole } from '../domain/states.js';
import type { ActorIdentity } from '../auth/types.js';
import type { CommandEnvelope } from '../commands/types.js';
import { TransactionalCommandExecutor } from '../commands/executor.js';
import { generateId } from '../commands/helpers.js';
import { nextVersion } from '../persistence/optimistic.js';
import type { DbClient } from '../persistence/types.js';
import type { ObservedPullRequestState } from './client.js';
import { syncPullRequestObservedState } from '../commands/handlers/github/pull-request-row.js';

import { RecordPrOpenedHandler } from '../commands/handlers/github/record-pr-opened.js';
import { RecordCiRunningHandler } from '../commands/handlers/github/record-ci-running.js';
import { RecordCiPassedHandler } from '../commands/handlers/github/record-ci-passed.js';
import { RecordCiFailedHandler } from '../commands/handlers/github/record-ci-failed.js';
import { RecordChangesRequestedHandler } from '../commands/handlers/github/record-changes-requested.js';
import { EscalateToHumanHandler } from '../commands/handlers/feature/escalate-to-human-required.js';

const SYSTEM_ACTOR_ID = 'github-reconciliation';

/** Bounded catch-up depth for a single reconcile call (HIGH-2). */
const MAX_RECONCILE_STEPS = 5;

function systemActor(correlationId: string): ActorIdentity {
  return { id: SYSTEM_ACTOR_ID, role: UserRole.ADMIN, actorKind: 'system', correlationId };
}

export type ReconciliationAction =
  | 'none'
  | 'pr_opened'
  | 'ci_running'
  | 'ci_passed'
  | 'ci_failed'
  | 'changes_requested'
  | 'escalated';

export interface ReconcileGithubStateOptions {
  db: DbClient;
  featureRunId: string;
  projectId: string;
  observed: ObservedPullRequestState;
  correlationId: string;
  /** Required only for actions that mutate a lock-gated transition (pr_opened, ci_running). */
  lockContext?: CommandEnvelope<unknown>['lockContext'];
}

export interface ReconcileGithubStateResult {
  /** The last action taken this call (`'none'` if nothing matched). */
  action: ReconciliationAction;
  /** Every action taken this call, in order — usually one entry, more on multi-step catch-up. */
  actions: ReconciliationAction[];
  resultingState?: FeatureExecutionState;
}

interface FeatureRunSnapshot {
  id: string;
  current_execution_state: string;
  version: number;
}

interface PullRequestSnapshot {
  ci_status: string;
  review_state: string;
}

/**
 * Feature-execution states whose GitHub-reconciliation actions (`RecordPrOpenedCommand`,
 * `RecordCiRunningCommand`) are execution-lane lock-gated (code-review MEDIUM-3). Callers use this
 * to decide whether acquiring the `execution-lane:<projectId>` `WorkflowLockManager` lock before
 * calling `reconcileGithubState` is necessary at all — CI-outcome and review-outcome transitions
 * (`RecordCiPassedCommand`/`RecordCiFailedCommand`/`RecordChangesRequestedCommand`) never require
 * `envelope.lockContext`.
 */
export function requiresExecutionLock(currentState: FeatureExecutionState): boolean {
  return (
    currentState === FeatureExecutionState.CODE_PUSHED ||
    currentState === FeatureExecutionState.PR_OPENED
  );
}

export async function reconcileGithubState(
  opts: ReconcileGithubStateOptions,
): Promise<ReconcileGithubStateResult> {
  const { db, featureRunId, projectId, observed, correlationId, lockContext } = opts;

  const runRows = await db.query<FeatureRunSnapshot>(
    `SELECT fr.id, fr.current_execution_state, fr.version
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE fr.id = ? AND freq.project_id = ?`,
    [featureRunId, projectId],
  );
  const run = runRows[0];
  if (!run) {
    throw new Error(
      `reconcileGithubState: feature run ${featureRunId} not found in project ${projectId}`,
    );
  }

  const prRows = await db.query<PullRequestSnapshot>(
    `SELECT ci_status, review_state FROM pull_requests WHERE feature_run_id = ?`,
    [featureRunId],
  );
  // Captured before the full-mirror sync below so the changes_requested branch can still tell a
  // freshly-observed review verdict apart from one it already recorded on a prior reconcile call.
  const priorReviewState = prRows[0]?.review_state;

  // Full observed-state mirror sync (HIGH-3 / MEDIUM-1): unconditionally writes every
  // GitHub-observed column onto pull_requests, on every reconciliation pass, regardless of which
  // action (if any) fires below. This is what makes pull_requests a true observed mirror per
  // docs/01 §5.7/§8 — a review approved/commented/dismissed outcome lands in
  // pull_requests.review_state even though only 'changes_requested' drives a feature-execution
  // transition (the matrix only gates on that one outcome). No-ops if the row doesn't exist yet
  // (e.g. currentState === CODE_PUSHED, before RecordPrOpenedHandler creates it below).
  await db.transaction(async (tx) => {
    await syncPullRequestObservedState(tx, featureRunId, observed);
  });

  const executor = new TransactionalCommandExecutor(db);
  const actor = systemActor(correlationId);

  const actions: ReconciliationAction[] = [];
  let currentState = run.current_execution_state as FeatureExecutionState;
  let expectedVersion = run.version;
  let resultingState: FeatureExecutionState | undefined;

  for (let step = 0; step < MAX_RECONCILE_STEPS; step += 1) {
    const stepResult = await runStep({
      executor,
      actor,
      correlationId,
      lockContext,
      featureRunId,
      projectId,
      observed,
      currentState,
      expectedVersion,
      priorReviewState,
    });
    if (!stepResult) break;
    actions.push(stepResult.action);
    resultingState = stepResult.resultingState;
    currentState = stepResult.resultingState ?? currentState;
    expectedVersion = nextVersion(expectedVersion);
  }

  // HIGH-2: a second full mirror-sync pass after the action loop. The pre-loop sync above no-ops
  // when no pull_requests row exists yet (e.g. currentState === CODE_PUSHED); if the loop then
  // creates the row via RecordPrOpenedHandler and keeps catching up further in the same call, the
  // freshly-inserted row would otherwise be stuck with insertPullRequestRow's hardcoded defaults
  // (mergeable=NULL, blocking_labels='[]', conversations_resolved=0) instead of the real observed
  // values. Unconditional (not gated on which action fired) — MEDIUM-1's diff-check inside
  // syncPullRequestObservedState makes this a cheap no-op write when the pre-loop sync already
  // captured everything.
  await db.transaction(async (tx) => {
    await syncPullRequestObservedState(tx, featureRunId, observed);
  });

  return {
    action: actions.length > 0 ? actions[actions.length - 1]! : 'none',
    actions,
    resultingState,
  };
}

interface RunStepOptions {
  executor: TransactionalCommandExecutor;
  actor: ActorIdentity;
  correlationId: string;
  lockContext?: CommandEnvelope<unknown>['lockContext'];
  featureRunId: string;
  projectId: string;
  observed: ObservedPullRequestState;
  currentState: FeatureExecutionState;
  expectedVersion: number;
  priorReviewState: string | undefined;
}

/** Runs (at most) one reconciliation action for the current state; null if nothing matches. */
async function runStep(
  opts: RunStepOptions,
): Promise<{ action: ReconciliationAction; resultingState?: FeatureExecutionState } | null> {
  const {
    executor,
    actor,
    correlationId,
    lockContext,
    featureRunId,
    projectId,
    observed,
    currentState,
    expectedVersion,
    priorReviewState,
  } = opts;

  const terminalStates: FeatureExecutionState[] = [
    FeatureExecutionState.MERGED,
    FeatureExecutionState.HUMAN_REQUIRED,
    FeatureExecutionState.BLOCKED,
    FeatureExecutionState.FAILED,
  ];
  const irreconcilablyClosed =
    observed.state === 'closed' && !observed.mergedAt && !terminalStates.includes(currentState);

  if (irreconcilablyClosed) {
    return escalate(executor, actor, correlationId, {
      featureRunId,
      projectId,
      expectedVersion,
      reason: `GitHub PR #${observed.prNumber} closed without merging while feature run was in state '${currentState}'`,
    });
  }

  if (currentState === FeatureExecutionState.CODE_PUSHED) {
    // HIGH-1: no longer gated on `!hasPrRow` — reconcileGithubState is only ever called with an
    // already-fetched `observed` (callers return early if GitHubClient.getPullRequest returned
    // null), so a PR is confirmed to exist by the time this branch runs regardless of whether a
    // local pull_requests row exists yet. This also makes a fix-cycle re-push
    // (changes_requested -> fixing -> code_pushed, reusing the *same* PR) reachable again — the
    // matrix guard below (assertValid) is the real transition gate, not PR row history.
    // insertPullRequestRow UPDATEs in place when a row already exists.
    const envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `record-pr-opened:${featureRunId}:${observed.prNumber}:${observed.headSha ?? 'nosha'}`,
      payload: {
        featureRunId,
        projectId,
        expectedVersion,
        prNumber: observed.prNumber,
        branchName: observed.branchName,
        baseBranch: observed.baseBranch,
        headSha: observed.headSha,
      },
      actor,
      correlationId,
      lockContext,
    };
    const result = await executor.execute(new RecordPrOpenedHandler(), envelope);
    return { action: 'pr_opened', resultingState: result.resultingState };
  }

  if (currentState === FeatureExecutionState.PR_OPENED && observed.ciStatus === 'running') {
    const envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `record-ci-running:${featureRunId}:${observed.prNumber}:${observed.headSha ?? 'nosha'}`,
      payload: {
        featureRunId,
        projectId,
        expectedVersion,
        checkRunId: `pr-${observed.prNumber}`,
      },
      actor,
      correlationId,
      lockContext,
    };
    const result = await executor.execute(new RecordCiRunningHandler(), envelope);
    return { action: 'ci_running', resultingState: result.resultingState };
  }

  if (
    currentState === FeatureExecutionState.PR_OPENED &&
    (observed.ciStatus === 'passed' || observed.ciStatus === 'failed')
  ) {
    // A missed `ci_running` webhook: CI is already terminal by the time we observe it. Advance
    // through CI_RUNNING first so the next loop iteration can record the terminal outcome
    // (HIGH-2) — the matrix has no direct pr_opened -> under_review/ci_failed transition.
    const envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `record-ci-running:${featureRunId}:${observed.prNumber}:${observed.headSha ?? 'nosha'}`,
      payload: {
        featureRunId,
        projectId,
        expectedVersion,
        checkRunId: `pr-${observed.prNumber}`,
      },
      actor,
      correlationId,
      lockContext,
    };
    const result = await executor.execute(new RecordCiRunningHandler(), envelope);
    return { action: 'ci_running', resultingState: result.resultingState };
  }

  if (currentState === FeatureExecutionState.CI_RUNNING) {
    if (observed.ciStatus === 'passed') {
      const envelope: CommandEnvelope<Record<string, unknown>> = {
        commandId: generateId(),
        idempotencyKey: `record-ci-passed:${featureRunId}:${observed.prNumber}:${observed.headSha ?? 'nosha'}`,
        payload: {
          featureRunId,
          projectId,
          expectedVersion,
          checkRunId: `pr-${observed.prNumber}`,
        },
        actor,
        correlationId,
      };
      const result = await executor.execute(new RecordCiPassedHandler(), envelope);
      return { action: 'ci_passed', resultingState: result.resultingState };
    }
    if (observed.ciStatus === 'failed') {
      const envelope: CommandEnvelope<Record<string, unknown>> = {
        commandId: generateId(),
        idempotencyKey: `record-ci-failed:${featureRunId}:${observed.prNumber}:${observed.headSha ?? 'nosha'}`,
        payload: {
          featureRunId,
          projectId,
          expectedVersion,
          checkRunId: `pr-${observed.prNumber}`,
        },
        actor,
        correlationId,
      };
      const result = await executor.execute(new RecordCiFailedHandler(), envelope);
      return { action: 'ci_failed', resultingState: result.resultingState };
    }
  }

  if (
    currentState === FeatureExecutionState.UNDER_REVIEW &&
    observed.reviewState === 'changes_requested' &&
    priorReviewState !== 'changes_requested'
  ) {
    const envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `changes-requested:${featureRunId}:${observed.prNumber}:${observed.headSha ?? 'nosha'}`,
      payload: {
        featureRunId,
        projectId,
        expectedVersion,
        reviewId: `pr-${observed.prNumber}-review`,
      },
      actor,
      correlationId,
    };
    const result = await executor.execute(new RecordChangesRequestedHandler(), envelope);
    return { action: 'changes_requested', resultingState: result.resultingState };
  }

  return null;
}

async function escalate(
  executor: TransactionalCommandExecutor,
  actor: ActorIdentity,
  correlationId: string,
  payload: { featureRunId: string; projectId: string; expectedVersion: number; reason: string },
): Promise<{ action: ReconciliationAction; resultingState?: FeatureExecutionState }> {
  const envelope: CommandEnvelope<Record<string, unknown>> = {
    commandId: generateId(),
    idempotencyKey: `escalate-human-github:${payload.featureRunId}`,
    payload,
    actor,
    correlationId,
  };
  const result = await executor.execute(new EscalateToHumanHandler(), envelope);
  return { action: 'escalated', resultingState: result.resultingState };
}
