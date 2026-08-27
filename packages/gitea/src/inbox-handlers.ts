/**
 * InboxHandler registrations for the normalized Gitea event taxonomy — the exact same taxonomy
 * `@minicoder/github`'s `inbox-handlers.ts` consumes (`pr.opened | pr.synchronized | pr.closed |
 * pr.merged | check.passed | check.failed | review.approved | review.changes_requested |
 * review.commented | review.comment | push`; Gitea has no webhook equivalent of
 * `review.dismissed` or `branch.protection_ok`, so neither is registered here).
 *
 * Each handler resolves the affected feature_run, fetches *current* authoritative state via
 * `ScmClient`, and delegates to the same `reconcileGithubState()` function the scheduled
 * `github-reconciliation` task uses — both the GitHub and Gitea webhook-triggered paths, and the
 * scheduled fallback, must run the identical algorithm (docs/01 §5.7). This module otherwise
 * mirrors `@minicoder/github`'s `inbox-handlers.ts` structurally; see that file's doc comment for
 * the full rationale behind the execution-lane lock-gating logic duplicated below.
 */

import type { DbClient, ScmClient } from '@minicoder/core';
import {
  reconcileGithubState,
  requiresExecutionLock,
  FeatureExecutionState,
} from '@minicoder/core';
import { WorkflowLockManager } from '@minicoder/workflow';

export interface GiteaInboxHandler {
  readonly eventType: string;
  handle(payload: unknown, schemaVersion: string): Promise<void>;
}

export interface NormalizedInboxPayload {
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

const HANDLED_EVENT_TYPES = [
  'pr.opened',
  'pr.synchronized',
  'pr.closed',
  'pr.merged',
  'check.passed',
  'check.failed',
  'review.approved',
  'review.changes_requested',
  'review.commented',
  'review.comment',
  'push',
] as const;

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
 * Identical resolution strategy to `@minicoder/github`'s `resolveFeatureRunId` — see that file's
 * doc comment for the full rationale of each fallback step. Duplicated rather than shared because
 * the two provider packages are peers with no dependency between them (matching this codebase's
 * "no cross-provider-package coupling" posture already established for webhook-signature
 * verification).
 */
export async function resolveFeatureRunId(
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

const LOCK_TTL_MS = 30_000;
const LOCK_HOLDER_ID = 'gitea-inbox-handler';

/**
 * Builds the InboxHandler map. `giteaClientFactory` is injected (real deployments resolve a
 * `GiteaScmClient` from a repository's `base_url`/token; tests inject a fake), keeping this module
 * usable without a live Gitea credential in tests.
 */
export function createGiteaInboxHandlers(
  db: DbClient,
  giteaClientFactory: () => Promise<ScmClient>,
): Map<string, GiteaInboxHandler> {
  const handlers = new Map<string, GiteaInboxHandler>();
  const lockManager = new WorkflowLockManager(db);

  for (const eventType of HANDLED_EVENT_TYPES) {
    handlers.set(eventType, {
      eventType,
      async handle(rawPayload: unknown): Promise<void> {
        const payload = rawPayload as NormalizedInboxPayload;
        const resolved = await resolveFeatureRunId(db, payload);
        if (!resolved) return;
        const { featureRunId, prNumber } = resolved;

        const repo = await resolveRepository(db, payload.projectId);
        if (!repo) return;

        const client = await giteaClientFactory();
        const observedResult = await client.getPullRequest(repo.owner, repo.name, prNumber);
        if (!observedResult) return;
        const observed: NonNullable<typeof observedResult> = observedResult;

        const stateRows = await db.query<FeatureRunStateRow>(
          `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
          [featureRunId],
        );
        const currentState = stateRows[0]?.current_execution_state as
          | FeatureExecutionState
          | undefined;
        const needsLock = currentState !== undefined && requiresExecutionLock(currentState);

        async function reconcileWithLock(): Promise<void> {
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
        }

        if (!needsLock) {
          const result = await reconcileGithubState({
            db,
            featureRunId,
            projectId: payload.projectId,
            observed,
            correlationId: `inbox-${eventType}-${featureRunId}`,
            lockContext: undefined,
          });
          if (result.action === 'lock_required') {
            await reconcileWithLock();
          }
          return;
        }

        await reconcileWithLock();
      },
    });
  }

  return handlers;
}
