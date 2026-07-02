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
 *
 * `changes_requested` re-entry (code-review round-6 HIGH-1): the `UNDER_REVIEW` branch used to
 * additionally gate on `priorReviewState !== 'changes_requested'`, reading `pull_requests
 * .review_state` *before* the mirror sync as an "already reacted to this" guard. That guard broke
 * down across a fix cycle: `syncPullRequestObservedState` runs unconditionally on *every*
 * reconcile pass, including passes where `currentState` is `PR_OPENED`/`CI_RUNNING` mid-fix-cycle
 * — and GitHub review decisions persist until dismissed or freshly re-reviewed, so if the reviewer
 * never re-reviewed the new commit, every one of those intermediate passes re-wrote
 * `review_state = 'changes_requested'`, overwriting `insertPullRequestRow`'s UPDATE-branch reset
 * long before the run ever reached `UNDER_REVIEW` again. `priorReviewState` then reflected
 * GitHub's stale, unchanged verdict rather than "has this run already reacted to this occurrence",
 * and the feature run could get stuck in `UNDER_REVIEW` while GitHub was still blocking. The guard
 * is removed; the branch now matches every other branch in this file — its idempotency key already
 * includes `observed.headSha`, so repeated calls for the *same* unresolved review on the *same*
 * commit collapse to the same key (true idempotency preserved), while fix-cycle re-entry with a
 * *new* `headSha` correctly gets a fresh key and fires again.
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

/**
 * `'lock_required'` (HIGH-3 code-review fix): a caller decided to skip acquiring the
 * `execution-lane:<projectId>` `WorkflowLockManager` lock based on an earlier, cheap
 * `feature_runs.current_execution_state` read (`requiresExecutionLock`), but by the time this
 * call's *own* internal state read ran, a concurrent writer (a racing webhook delivery, or the
 * scheduled fallback overlapping a webhook delivery) had already advanced the same feature run
 * into `code_pushed`/`pr_opened` — a state whose next reconciliation action really does need the
 * lock. Rather than hard-throwing a `CommandError` from inside a lock-gated handler (which
 * `InboxProcessor` would catch and retry later with backoff), `runStep` reports `'lock_required'`
 * and the loop in `reconcileGithubState` stops immediately without executing that step. The caller
 * is expected to acquire the lock and call `reconcileGithubState` once more — see
 * `packages/github/src/inbox-handlers.ts` and
 * `packages/triggerdev/src/tasks/github-reconciliation.ts`.
 */
export type ReconciliationAction =
  | 'none'
  | 'pr_opened'
  | 'ci_running'
  | 'ci_passed'
  | 'ci_failed'
  | 'changes_requested'
  | 'escalated'
  | 'lock_required';

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
    });
    if (!stepResult) break;
    actions.push(stepResult.action);
    // HIGH-3: 'lock_required' means the step that would advance the feature run needs
    // `lockContext` but none was supplied — stop the catch-up loop immediately rather than
    // treating it as a completed action or continuing to a state read that's now known-stale.
    // The caller (inbox handler / scheduled task) is responsible for re-invoking
    // `reconcileGithubState` once more with a freshly acquired lock; that second call does its own
    // fresh internal state read, so it naturally picks up whatever changed underneath this call.
    if (stepResult.action === 'lock_required') break;
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
    // HIGH-3: this branch dispatches RecordPrOpenedCommand, which is execution-lane lock-gated
    // (requiresExecutionLock). Callers that determined no lock was needed based on an earlier,
    // now-possibly-stale state read must not fall through to a hard-throwing lock-gated handler
    // call here — report 'lock_required' so `reconcileGithubState`'s loop stops cleanly and the
    // caller can retry once with a freshly acquired lock (see the `ReconciliationAction` doc
    // comment on 'lock_required').
    if (!lockContext) return { action: 'lock_required' };
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
    // HIGH-3: see the CODE_PUSHED branch above — RecordCiRunningCommand is also lock-gated.
    if (!lockContext) return { action: 'lock_required' };
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
    // HIGH-3: this also dispatches RecordCiRunningCommand — same lock-gated guard as above.
    if (!lockContext) return { action: 'lock_required' };
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
    observed.reviewState === 'changes_requested'
  ) {
    // round-6 HIGH-1: no `priorReviewState` pre-check here — see the module doc comment above.
    // Idempotency is entirely carried by the key below (includes `observed.headSha`), matching
    // every other branch in this file.
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
