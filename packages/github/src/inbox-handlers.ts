/**
 * InboxHandler registrations for the normalized GitHub event taxonomy
 * (pr.opened | pr.synchronized | pr.closed | pr.merged | check.passed | check.failed |
 *  review.approved | review.changes_requested | review.dismissed | review.comment | push |
 *  branch.protection_ok).
 *
 * Each handler resolves the affected feature_run, fetches *current* authoritative state via
 * GitHubClient, and delegates to the same `reconcileGithubState` function the scheduled
 * `github-reconciliation` task uses (packages/triggerdev/src/tasks/github-reconciliation.ts) —
 * both paths must run the identical algorithm (docs/01 §5.7). This module has no dependency on
 * `@minicoder/workflow`'s `InboxHandler` type: the returned objects satisfy that interface
 * structurally (`{ eventType, handle(payload, schemaVersion) }`).
 *
 * Some reconciliation actions (RecordPrOpenedCommand, RecordCiRunningCommand) are execution-lane
 * lock-gated, matching RecordCodePushedHandler's guard. Only those two actions ever require
 * `envelope.lockContext` (see `requiresExecutionLock()` in `@minicoder/core`'s reconcile module) —
 * CI-outcome/review-outcome transitions never do. This handler does a cheap `feature_runs`
 * lookup for `current_execution_state` before deciding whether to acquire the
 * `execution-lane:<projectId>` lock `SelectFeatureCommand`/`RecordCodePushedCommand` use, skipping
 * acquisition entirely (and calling `reconcileGithubState()` with `lockContext: undefined`) when
 * the current state can never need it (MEDIUM-3 code-review fix).
 */

import type { DbClient, GitHubClient } from '@minicoder/core';
import {
  reconcileGithubState,
  requiresExecutionLock,
  FeatureExecutionState,
} from '@minicoder/core';
import { WorkflowLockManager } from '@minicoder/workflow';

export interface GithubInboxHandler {
  readonly eventType: string;
  handle(payload: unknown, schemaVersion: string): Promise<void>;
}

interface NormalizedInboxPayload {
  projectId: string;
  prNumber: number | null;
  featureRunId?: string;
  branchName?: string;
  [key: string]: unknown;
}

interface RepositoryRow {
  owner: string;
  name: string;
}

interface FeatureRunLookupRow {
  id: string;
  pr_number: number;
}

interface FeatureRunStateRow {
  current_execution_state: string;
}

/**
 * Events with a normal reconciliation handler: each resolves a feature_run, fetches observed
 * GitHub state, and calls `reconcileGithubState`.
 *   - `review.comment` (pull_request_review_comment) and `push` are HIGH-5 code-review fixes:
 *     both carry either a PR number or a `minicoder/FR-*` branch name that `resolveFeatureRunId`
 *     already knows how to resolve, so no bespoke handler logic is needed — reconciling on them
 *     lets a review comment that resolves a conversation (conversations_resolved) or a
 *     mid-CI push get picked up promptly instead of waiting for the next event/scheduled pass.
 */
const HANDLED_EVENT_TYPES = [
  'pr.opened',
  'pr.synchronized',
  'pr.closed',
  'pr.merged',
  'check.passed',
  'check.failed',
  'review.approved',
  'review.changes_requested',
  'review.dismissed',
  'review.comment',
  'push',
] as const;

/**
 * `branch.protection_ok` is only ever produced by `minicoder github simulate-*` (CLI dev tooling),
 * not by `normalize.ts`'s real webhook taxonomy, and is not part of docs/01 §5.7's consumed-event
 * list. Without a registered handler, `InboxProcessor` requeues it forever (HIGH-5) — register a
 * trivial no-op handler so simulate-driven inbox rows still resolve to 'processed' instead of
 * becoming a permanent backlog entry.
 */
const NOOP_EVENT_TYPES = ['branch.protection_ok'] as const;

async function resolveRepository(db: DbClient, projectId: string): Promise<RepositoryRow | null> {
  const rows = await db.query<RepositoryRow>(
    `SELECT owner, name FROM repositories WHERE project_id = ? LIMIT 1`,
    [projectId],
  );
  return rows[0] ?? null;
}

export interface ResolvedFeatureRun {
  featureRunId: string;
  prNumber: number;
}

/**
 * Resolves the feature_run (and its tracked PR number) affected by a webhook payload. Preference
 * order:
 *   1. payload.featureRunId, if the caller (e.g. `minicoder github simulate-*`) supplied it —
 *      paired with payload.prNumber or, failing that, whatever pull_requests already has on file.
 *   2. An existing pull_requests row already tracking this PR number for the project.
 *   3. The branch name (`minicoder/<frId>` per docs/01 §5.7), resolved to the feature_request's
 *      most recent feature_runs row, paired with that run's tracked PR number if any.
 *   4. (HIGH-4) The commit SHA, for legacy `status` webhook events — normalized to
 *      `check.passed`/`check.failed` with `prNumber: null` and only `sha` in the payload
 *      (packages/github/src/normalize.ts's `status` case) — resolved via pull_requests.head_sha.
 *
 * Returns null (and, distinctly, a resolved run with `prNumber` unset) only when no PR number can
 * be determined at all — the caller needs a concrete PR number to call GitHubClient.getPullRequest.
 */
async function resolveFeatureRunId(
  db: DbClient,
  payload: NormalizedInboxPayload,
): Promise<ResolvedFeatureRun | null> {
  if (payload.featureRunId) {
    if (payload.prNumber !== null && payload.prNumber !== undefined) {
      return { featureRunId: payload.featureRunId, prNumber: payload.prNumber };
    }
    const rows = await db.query<{ pr_number: number }>(
      `SELECT pr_number FROM pull_requests WHERE feature_run_id = ?`,
      [payload.featureRunId],
    );
    if (rows[0]) return { featureRunId: payload.featureRunId, prNumber: rows[0].pr_number };
    return null;
  }

  if (payload.prNumber !== null && payload.prNumber !== undefined) {
    const rows = await db.query<FeatureRunLookupRow>(
      `SELECT pr.feature_run_id AS id, pr.pr_number AS pr_number
       FROM pull_requests pr
       JOIN feature_runs fr ON fr.id = pr.feature_run_id
       JOIN feature_requests freq ON freq.id = fr.feature_request_id
       WHERE freq.project_id = ? AND pr.pr_number = ?`,
      [payload.projectId, payload.prNumber],
    );
    if (rows[0]) return { featureRunId: rows[0].id, prNumber: rows[0].pr_number };
  }

  if (payload.branchName) {
    const frId = payload.branchName.startsWith('minicoder/')
      ? payload.branchName.slice('minicoder/'.length)
      : null;
    if (frId) {
      const rows = await db.query<FeatureRunLookupRow & { pr_number: number | null }>(
        `SELECT fr.id AS id, pr.pr_number AS pr_number
         FROM feature_runs fr
         JOIN feature_requests freq ON freq.id = fr.feature_request_id
         LEFT JOIN pull_requests pr ON pr.feature_run_id = fr.id
         WHERE freq.project_id = ? AND freq.fr_id = ?
         ORDER BY fr.attempt_no DESC
         LIMIT 1`,
        [payload.projectId, frId],
      );
      if (rows[0]) {
        const prNumber = rows[0].pr_number ?? payload.prNumber;
        if (prNumber !== null && prNumber !== undefined) {
          return { featureRunId: rows[0].id, prNumber };
        }
      }
    }
  }

  const sha = typeof payload['sha'] === 'string' ? (payload['sha'] as string) : null;
  if (sha) {
    const rows = await db.query<FeatureRunLookupRow>(
      `SELECT pr.feature_run_id AS id, pr.pr_number AS pr_number
       FROM pull_requests pr
       JOIN feature_runs fr ON fr.id = pr.feature_run_id
       JOIN feature_requests freq ON freq.id = fr.feature_request_id
       WHERE freq.project_id = ? AND pr.head_sha = ?`,
      [payload.projectId, sha],
    );
    if (rows[0]) return { featureRunId: rows[0].id, prNumber: rows[0].pr_number };
  }

  return null;
}

/**
 * Builds the InboxHandler map. `githubClientFactory` is injected (real deployments resolve an
 * `OctokitGitHubClient` from env; tests inject a `MockGitHubClient`), keeping this module usable
 * without a live GitHub credential in tests.
 */
const LOCK_TTL_MS = 30_000;
const LOCK_HOLDER_ID = 'github-inbox-handler';

export function createGithubInboxHandlers(
  db: DbClient,
  githubClientFactory: () => Promise<GitHubClient>,
): Map<string, GithubInboxHandler> {
  const handlers = new Map<string, GithubInboxHandler>();
  const lockManager = new WorkflowLockManager(db);

  for (const eventType of HANDLED_EVENT_TYPES) {
    handlers.set(eventType, {
      eventType,
      async handle(rawPayload: unknown): Promise<void> {
        const payload = rawPayload as NormalizedInboxPayload;
        const resolved = await resolveFeatureRunId(db, payload);
        if (!resolved) {
          // No tracked feature run (or no known PR number) for this event yet — nothing to
          // reconcile. Marking the delivery processed is correct: there is nothing more to learn
          // from this specific payload once a feature run can't be resolved from it.
          return;
        }
        const { featureRunId, prNumber } = resolved;

        const repo = await resolveRepository(db, payload.projectId);
        if (!repo) return;

        const client = await githubClientFactory();
        const observed = await client.getPullRequest(repo.owner, repo.name, prNumber);
        if (!observed) return;

        // MEDIUM-3: only pr_opened/ci_running (execution-lane lock-gated) ever need the lock —
        // look up the run's current state cheaply and skip acquire/release entirely otherwise.
        const stateRows = await db.query<FeatureRunStateRow>(
          `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
          [featureRunId],
        );
        const currentState = stateRows[0]?.current_execution_state as
          | FeatureExecutionState
          | undefined;
        const needsLock = currentState !== undefined && requiresExecutionLock(currentState);

        if (!needsLock) {
          await reconcileGithubState({
            db,
            featureRunId,
            projectId: payload.projectId,
            observed,
            correlationId: `inbox-${eventType}-${featureRunId}`,
            lockContext: undefined,
          });
          return;
        }

        // A LockConflictError here (another execution-lane holder, e.g. an active Coder run,
        // currently owns the lock) propagates to InboxProcessor, which marks the delivery
        // 'failed' with backoff — it is retried on a later poll rather than dropped.
        const acquired = await lockManager.acquire(
          payload.projectId,
          `execution-lane:${payload.projectId}`,
          { holderId: LOCK_HOLDER_ID, ttlMs: LOCK_TTL_MS },
        );

        try {
          await reconcileGithubState({
            db,
            featureRunId,
            projectId: payload.projectId,
            observed,
            correlationId: `inbox-${eventType}-${featureRunId}`,
            lockContext: {
              lockId: acquired.lockId,
              fence: acquired.fence,
              holderId: acquired.holderId,
              projectId: payload.projectId,
              resourceKey: `execution-lane:${payload.projectId}`,
            },
          });
        } finally {
          await lockManager.release(acquired);
        }
      },
    });
  }

  for (const eventType of NOOP_EVENT_TYPES) {
    handlers.set(eventType, {
      eventType,
      async handle(): Promise<void> {
        // No-op: not part of the real webhook taxonomy (dev-only `minicoder github simulate-*`
        // surface). Registering a handler at all is what marks these inbox rows 'processed'
        // instead of requeuing forever (HIGH-5).
      },
    });
  }

  return handlers;
}
