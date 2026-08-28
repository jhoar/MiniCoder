import {
  FeatureExecutionState,
  MergeGateBlockedError,
  RecordApprovedByPolicyHandler,
  TransactionalCommandExecutor,
  generateId,
  publishMergeGateStatusCheck,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { RunMergeGatePayload } from './types.js';
import { systemActor } from './actor.js';
import { isTransientRace as isTransientRaceShared } from './transient-race.js';
import { resolveDefaultScmClient, type ScmClientResolver } from './scm-client-resolver.js';

export type { RunMergeGatePayload };

export interface RunMergeGateResult {
  projectId: string;
  featureRunId: string;
  evaluated: boolean;
  approved: boolean;
  reasons: string[];
}

export interface RunMergeGateDeps {
  /** Stage 6 write-pipeline follow-up (docs/06 §Phase 18): resolves the correct `ScmClient`
   * implementation/credential for this run's repository's own `provider`/`base_url`, instead of
   * unconditionally constructing `OctokitGitHubClient`. */
  resolveScmClient?: ScmClientResolver;
}

const recordApprovedByPolicyHandler = new RecordApprovedByPolicyHandler();

// A concurrent invocation of this same task (or a webhook-triggered path racing it) hitting the
// same idempotency key is the only expected non-fatal race here — unlike run-review.ts/run-coder.ts,
// this task never acquires the execution-lane lock (under_review -> approved_by_policy is not
// lock-gated — see requiresExecutionLock() in reconcile.ts).
const EXPECTED_COMMAND_ERROR_TYPES = new Set(['concurrent-command', 'not-found']);

function isTransientRace(err: unknown): boolean {
  return isTransientRaceShared(err, EXPECTED_COMMAND_ERROR_TYPES);
}

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
}

interface PullRequestRow {
  head_sha: string | null;
}

interface RepositoryRow {
  owner: string;
  name: string;
  provider: string;
  base_url: string | null;
}

/**
 * `minicoder trigger`-style operator action: "recompute merge gate" (docs/00 §4.4 — an operator
 * capability, distinct from the approver-only `merge-if-ready`). A separate, independently
 * scheduled/triggered task from `run-review.ts`/`run-coder.ts`/`start-next-feature.ts` (CLAUDE.md's
 * "never inline" rule for GitHub-facing/execution tasks) — a clean review leaves a feature run at
 * `under_review` with no automatic follow-up (Phase 10's documented posture: "Phase 12's Merge Gate
 * owns that transition"), and this task is that follow-up. It is safe to invoke repeatedly and on
 * a schedule: a feature run not at `under_review` is a no-op, and `RecordApprovedByPolicyHandler`
 * itself unconditionally writes a `merge_gate_evaluations` audit row on every call whether or not
 * the gate passes.
 *
 * Publishes the `minicoder/review-gate` status check (docs/01 §5.7/§12) onto the PR's current head
 * commit after every evaluation, win or lose — a status-check publish failure is logged and
 * swallowed (mirrors `run-coder.ts`'s "PR-creation failure after a successful push is never
 * re-thrown" contract): the state transition (or lack of one) is already durably recorded by this
 * point, and a transient GitHub API hiccup publishing the check is not a reason to fail the task.
 */
export async function runImpl(
  payload: RunMergeGatePayload,
  db: DbClient,
  deps: RunMergeGateDeps = {},
): Promise<RunMergeGateResult> {
  const { projectId, featureRunId, correlationId } = payload;
  const resolveScmClient = deps.resolveScmClient ?? resolveDefaultScmClient('run-merge-gate');

  const runRows = await db.query<FeatureRunRow>(
    `SELECT fr.id, fr.current_execution_state, fr.version
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE fr.id = ? AND freq.project_id = ?`,
    [featureRunId, projectId],
  );
  const run = runRows[0];
  if (!run || run.current_execution_state !== FeatureExecutionState.UNDER_REVIEW) {
    return { projectId, featureRunId, evaluated: false, approved: false, reasons: [] };
  }

  const executor = new TransactionalCommandExecutor(db);
  const actor = systemActor(correlationId);
  const envelope: CommandEnvelope<Record<string, unknown>> = {
    commandId: generateId(),
    // {expectedVersion}-scoped (code-review fix): under_review -> approved_by_policy can recur
    // for the same feature run (e.g. after a merge_failed auto-clear returns it to under_review
    // and it is re-approved) — a key scoped to featureRunId alone would replay the *first*
    // approval's cached result for every later occurrence within the idempotency TTL.
    idempotencyKey: `approved-by-policy:${featureRunId}:${run.version}`,
    payload: { featureRunId, projectId, expectedVersion: run.version },
    actor,
    correlationId,
  };

  let outcome: { evaluated: boolean; approved: boolean; reasons: string[] };
  try {
    await executor.execute(recordApprovedByPolicyHandler, envelope);
    outcome = { evaluated: true, approved: true, reasons: [] };
  } catch (err) {
    if (err instanceof MergeGateBlockedError) {
      outcome = { evaluated: true, approved: false, reasons: err.reasons };
    } else if (isTransientRace(err)) {
      return { projectId, featureRunId, evaluated: false, approved: false, reasons: [] };
    } else {
      throw err;
    }
  }

  if (outcome.evaluated) {
    await publishStatusCheckSafely(db, resolveScmClient, {
      projectId,
      featureRunId,
      decision: outcome.approved ? 'approved' : 'rejected',
      reasons: outcome.reasons,
    });
  }

  return { projectId, featureRunId, ...outcome };
}

async function publishStatusCheckSafely(
  db: DbClient,
  resolveScmClient: ScmClientResolver,
  opts: {
    projectId: string;
    featureRunId: string;
    decision: 'approved' | 'rejected';
    reasons: string[];
  },
): Promise<void> {
  try {
    const prRows = await db.query<PullRequestRow>(
      `SELECT head_sha FROM pull_requests WHERE feature_run_id = ?`,
      [opts.featureRunId],
    );
    const repoRows = await db.query<RepositoryRow>(
      `SELECT owner, name, provider, base_url FROM repositories WHERE project_id = ? LIMIT 1`,
      [opts.projectId],
    );
    const pr = prRows[0];
    const repo = repoRows[0];
    if (!pr?.head_sha || !repo) return;

    const githubClient = await resolveScmClient(repo.provider, repo.base_url);
    await publishMergeGateStatusCheck(githubClient, {
      owner: repo.owner,
      repo: repo.name,
      sha: pr.head_sha,
      decision: opts.decision,
      reasons: opts.reasons,
    });
  } catch (err) {
    console.error(
      `run-merge-gate: failed to publish minicoder/review-gate status check for ${opts.featureRunId}`,
      err,
    );
  }
}
