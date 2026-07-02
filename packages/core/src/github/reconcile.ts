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
 */

import { FeatureExecutionState, UserRole } from '../domain/states.js';
import type { ActorIdentity } from '../auth/types.js';
import type { CommandEnvelope } from '../commands/types.js';
import { TransactionalCommandExecutor } from '../commands/executor.js';
import { generateId } from '../commands/helpers.js';
import type { DbClient } from '../persistence/types.js';
import type { ObservedPullRequestState } from './client.js';

import { RecordPrOpenedHandler } from '../commands/handlers/github/record-pr-opened.js';
import { RecordCiRunningHandler } from '../commands/handlers/github/record-ci-running.js';
import { RecordCiPassedHandler } from '../commands/handlers/github/record-ci-passed.js';
import { RecordCiFailedHandler } from '../commands/handlers/github/record-ci-failed.js';
import { RecordChangesRequestedHandler } from '../commands/handlers/github/record-changes-requested.js';
import { EscalateToHumanHandler } from '../commands/handlers/feature/escalate-to-human-required.js';

const SYSTEM_ACTOR_ID = 'github-reconciliation';

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
  action: ReconciliationAction;
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
    throw new Error(`reconcileGithubState: feature run ${featureRunId} not found in project ${projectId}`);
  }

  const prRows = await db.query<PullRequestSnapshot>(
    `SELECT ci_status, review_state FROM pull_requests WHERE feature_run_id = ?`,
    [featureRunId],
  );
  const pr = prRows[0];

  const currentState = run.current_execution_state as FeatureExecutionState;
  const executor = new TransactionalCommandExecutor(db);
  const actor = systemActor(correlationId);
  const expectedVersion = run.version;

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

  if (currentState === FeatureExecutionState.CODE_PUSHED && !pr) {
    const envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `record-pr-opened:${featureRunId}:${observed.prNumber}`,
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
      idempotencyKey: `record-ci-running:${featureRunId}:${observed.prNumber}`,
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
        idempotencyKey: `record-ci-passed:${featureRunId}:${observed.prNumber}`,
        payload: { featureRunId, projectId, expectedVersion, checkRunId: `pr-${observed.prNumber}` },
        actor,
        correlationId,
      };
      const result = await executor.execute(new RecordCiPassedHandler(), envelope);
      return { action: 'ci_passed', resultingState: result.resultingState };
    }
    if (observed.ciStatus === 'failed') {
      const envelope: CommandEnvelope<Record<string, unknown>> = {
        commandId: generateId(),
        idempotencyKey: `record-ci-failed:${featureRunId}:${observed.prNumber}`,
        payload: { featureRunId, projectId, expectedVersion, checkRunId: `pr-${observed.prNumber}` },
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
    pr?.review_state !== 'changes_requested'
  ) {
    const envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `changes-requested:${featureRunId}:${observed.prNumber}`,
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

  return { action: 'none' };
}

async function escalate(
  executor: TransactionalCommandExecutor,
  actor: ActorIdentity,
  correlationId: string,
  payload: { featureRunId: string; projectId: string; expectedVersion: number; reason: string },
): Promise<ReconcileGithubStateResult> {
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
