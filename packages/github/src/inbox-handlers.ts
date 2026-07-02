/**
 * InboxHandler registrations for the normalized GitHub event taxonomy
 * (pr.opened | pr.synchronized | pr.closed | pr.merged | check.passed | check.failed |
 *  review.approved | review.changes_requested | review.dismissed).
 *
 * Each handler resolves the affected feature_run, fetches *current* authoritative state via
 * GitHubClient, and delegates to the same `reconcileGithubState` function the scheduled
 * `github-reconciliation` task uses (packages/triggerdev/src/tasks/github-reconciliation.ts) —
 * both paths must run the identical algorithm (docs/01 §5.7). This module has no dependency on
 * `@minicoder/workflow`'s `InboxHandler` type: the returned objects satisfy that interface
 * structurally (`{ eventType, handle(payload, schemaVersion) }`).
 *
 * Some reconciliation actions (RecordPrOpenedCommand, RecordCiRunningCommand) are execution-lane
 * lock-gated, matching RecordCodePushedHandler's guard — the handler acquires the same
 * `execution-lane:<projectId>` lock `SelectFeatureCommand`/`RecordCodePushedCommand` use before
 * calling `reconcileGithubState()`, and releases it afterward. Acquiring unconditionally (even for
 * actions that turn out not to need it) is simpler than threading "does this observed state need
 * a lock" logic through this module and keeps this handler correct if reconcile's dispatch logic
 * grows more lock-gated actions later.
 */

import type { DbClient, GitHubClient } from '@minicoder/core';
import { reconcileGithubState } from '@minicoder/core';
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
}

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
] as const;

async function resolveRepository(db: DbClient, projectId: string): Promise<RepositoryRow | null> {
  const rows = await db.query<RepositoryRow>(
    `SELECT owner, name FROM repositories WHERE project_id = ? LIMIT 1`,
    [projectId],
  );
  return rows[0] ?? null;
}

/**
 * Resolves the feature_run affected by a webhook payload. Preference order:
 *   1. payload.featureRunId, if the caller (e.g. `minicoder github simulate-*`) supplied it.
 *   2. An existing pull_requests row already tracking this PR number for the project.
 *   3. The branch name (`minicoder/<frId>` per docs/01 §5.7), resolved to the feature_request's
 *      most recent feature_runs row.
 */
async function resolveFeatureRunId(
  db: DbClient,
  payload: NormalizedInboxPayload,
): Promise<string | null> {
  if (payload.featureRunId) return payload.featureRunId;

  if (payload.prNumber !== null && payload.prNumber !== undefined) {
    const rows = await db.query<FeatureRunLookupRow>(
      `SELECT pr.feature_run_id AS id
       FROM pull_requests pr
       JOIN feature_runs fr ON fr.id = pr.feature_run_id
       JOIN feature_requests freq ON freq.id = fr.feature_request_id
       WHERE freq.project_id = ? AND pr.pr_number = ?`,
      [payload.projectId, payload.prNumber],
    );
    if (rows[0]) return rows[0].id;
  }

  if (payload.branchName) {
    const frId = payload.branchName.startsWith('minicoder/')
      ? payload.branchName.slice('minicoder/'.length)
      : null;
    if (frId) {
      const rows = await db.query<FeatureRunLookupRow>(
        `SELECT fr.id AS id
         FROM feature_runs fr
         JOIN feature_requests freq ON freq.id = fr.feature_request_id
         WHERE freq.project_id = ? AND freq.fr_id = ?
         ORDER BY fr.attempt_no DESC
         LIMIT 1`,
        [payload.projectId, frId],
      );
      if (rows[0]) return rows[0].id;
    }
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
        const featureRunId = await resolveFeatureRunId(db, payload);
        if (!featureRunId) {
          // No tracked feature run for this PR/branch yet — nothing to reconcile.
          return;
        }
        if (payload.prNumber === null || payload.prNumber === undefined) return;

        const repo = await resolveRepository(db, payload.projectId);
        if (!repo) return;

        const client = await githubClientFactory();
        const observed = await client.getPullRequest(repo.owner, repo.name, payload.prNumber);
        if (!observed) return;

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

  return handlers;
}
