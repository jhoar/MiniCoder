import type { TxClient } from '../../../persistence/types.js';
import { generateId, isoNow } from '../../helpers.js';
import type { ObservedPullRequestState } from '../../../github/client.js';

export interface PullRequestRow {
  id: string;
  feature_run_id: string;
  pr_number: number;
  branch_name: string;
  base_branch: string;
  head_sha: string | null;
  state: string;
  review_state: string;
  ci_status: string;
  mergeable: number | boolean | null;
  /** JSON string on SQLite (`TEXT`); already-parsed array on PostgreSQL (`JSONB`) — see `labelsEqual`. */
  blocking_labels: string | string[];
  conversations_resolved: number | boolean;
  /** ISO string on SQLite (`TEXT`); `Date` on PostgreSQL (`TIMESTAMPTZ`) — see `timestampsEqual`. */
  merged_at: string | Date | null;
  merge_sha: string | null;
  /** ISO string on SQLite (`TEXT`); `Date` on PostgreSQL (`TIMESTAMPTZ`) — see `timestampsEqual`. */
  closed_at: string | Date | null;
  version: number;
}

export async function getPullRequestByFeatureRun(
  tx: TxClient,
  featureRunId: string,
): Promise<PullRequestRow | undefined> {
  const rows = await tx.query<PullRequestRow>(
    `SELECT id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state,
            review_state, ci_status, mergeable, blocking_labels, conversations_resolved,
            merged_at, merge_sha, closed_at, version
     FROM pull_requests WHERE feature_run_id = ?`,
    [featureRunId],
  );
  return rows[0];
}

/**
 * Inserts the initial pull_requests row for a feature run (record-pr-opened) or, if a row already
 * exists for this feature_run_id (idempotent replay / same feature run reopened after a prior PR
 * closed), overwrites it in place — feature_run_id is UNIQUE (migration 0009), so a feature run
 * has at most one tracked pull request row at a time.
 */
export async function insertPullRequestRow(
  tx: TxClient,
  opts: {
    id: string;
    featureRunId: string;
    prNumber: number;
    branchName: string;
    baseBranch: string;
    headSha: string | null;
  },
): Promise<void> {
  const now = isoNow();
  const existing = await getPullRequestByFeatureRun(tx, opts.featureRunId);
  if (existing) {
    await tx.execute(
      `UPDATE pull_requests
       SET pr_number = ?, branch_name = ?, base_branch = ?, head_sha = ?, state = 'open',
           review_state = 'none', ci_status = 'pending', mergeable = NULL,
           blocking_labels = '[]', conversations_resolved = 0,
           merged_at = NULL, merge_sha = NULL, closed_at = NULL,
           version = version + 1, updated_at = ?
       WHERE feature_run_id = ?`,
      [opts.prNumber, opts.branchName, opts.baseBranch, opts.headSha, now, opts.featureRunId],
    );
    return;
  }
  await tx.execute(
    `INSERT INTO pull_requests
       (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
        ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', 'none', 'pending', '[]', 0, 1, ?, ?)`,
    [
      opts.id,
      opts.featureRunId,
      opts.prNumber,
      opts.branchName,
      opts.baseBranch,
      opts.headSha,
      now,
      now,
    ],
  );
}

export async function updatePullRequestCiStatus(
  tx: TxClient,
  featureRunId: string,
  ciStatus: string,
): Promise<void> {
  await tx.execute(
    `UPDATE pull_requests SET ci_status = ?, version = version + 1, updated_at = ? WHERE feature_run_id = ?`,
    [ciStatus, isoNow(), featureRunId],
  );
}

export async function updatePullRequestReviewState(
  tx: TxClient,
  featureRunId: string,
  reviewState: string,
): Promise<void> {
  await tx.execute(
    `UPDATE pull_requests SET review_state = ?, version = version + 1, updated_at = ? WHERE feature_run_id = ?`,
    [reviewState, isoNow(), featureRunId],
  );
}

/** Normalizes SQLite's 0/1 and PostgreSQL's boolean representations to a plain boolean. */
function asBool(value: number | boolean | null): boolean {
  return value === true || value === 1;
}

/**
 * MEDIUM-1 code-review fix: normalizes `blocking_labels` before comparing against the freshly
 * observed labels. Migration 0009 declares `blocking_labels` `JSONB` on PostgreSQL and `TEXT` on
 * SQLite; `packages/persistence-postgres/src/client.ts` does zero type coercion, so `pg` returns
 * an already-parsed JS array for a JSONB column while the SQLite driver returns the raw JSON
 * string. A plain `existing.blocking_labels === JSON.stringify(observed)` string comparison (the
 * pre-fix code) therefore never matches on PostgreSQL, permanently churning `version`/`updated_at`
 * on every reconciliation pass. Parses `existing` only when it's a string; uses it directly when
 * it's already an array.
 */
function labelsEqual(existing: unknown, observed: string[]): boolean {
  const existingLabels: unknown = typeof existing === 'string' ? JSON.parse(existing) : existing;
  return JSON.stringify(existingLabels) === JSON.stringify(observed);
}

/**
 * MEDIUM-1 code-review fix: normalizes timestamp comparison the same way `labelsEqual` normalizes
 * labels. Migration 0009 declares `merged_at`/`closed_at` `TIMESTAMPTZ` on PostgreSQL; `pg` returns
 * a `Date` object there (vs. a plain ISO string on SQLite), so a bare `===` string comparison (the
 * pre-fix code) never matches on PostgreSQL. Compares via `Date.parse`/numeric equality instead,
 * which also tolerates millisecond-formatting differences between what GitHub's API returns and
 * what a round-tripped PostgreSQL `Date.toISOString()` would produce. `null === null` short-circuits
 * without going through `Date.parse` (which would otherwise yield `NaN` for both sides and compare
 * unequal to itself).
 */
function timestampsEqual(existing: string | Date | null, observed: string | null): boolean {
  if (existing === null && observed === null) return true;
  if (existing === null || observed === null) return false;
  const existingMs = existing instanceof Date ? existing.getTime() : Date.parse(existing);
  const observedMs = Date.parse(observed);
  return existingMs === observedMs;
}

/**
 * Full observed-state mirror sync (HIGH-3 / MEDIUM-1 code-review fix): writes every
 * GitHub-observed column onto the existing `pull_requests` row for `featureRunId`, not just
 * `ci_status`/`review_state` — `head_sha`, `state`, `mergeable`, `blocking_labels`,
 * `conversations_resolved`, `merged_at`, `merge_sha`, `closed_at` all land here too, whatever
 * `review_state` GitHub reports (`approved`/`commented`/`dismissed`/`changes_requested`/`none`),
 * not just `changes_requested`. This is a no-op if no `pull_requests` row exists yet for
 * `featureRunId` — `reconcileGithubState` calls this unconditionally before any action branch, and
 * the `code_pushed -> pr_opened` branch is responsible for first creating the row via
 * `insertPullRequestRow`. Superseded `updatePullRequestCiStatus`/`updatePullRequestReviewState`
 * single-column writes remain exported for now but are no longer called by the Record* handlers,
 * which rely on this full sync instead.
 *
 * MEDIUM-1: reads the current row first and skips the `UPDATE` entirely when every observed field
 * already matches what's stored, so two consecutive reconciliations with identical observed state
 * don't churn `version`/`updated_at` on the second call — this also makes HIGH-2's second
 * post-loop sync call free in the common case where the pre-loop sync already captured everything.
 */
export async function syncPullRequestObservedState(
  tx: TxClient,
  featureRunId: string,
  observed: ObservedPullRequestState,
): Promise<void> {
  const existing = await getPullRequestByFeatureRun(tx, featureRunId);
  if (!existing) return;

  const observedBlockingLabels = JSON.stringify(observed.blockingLabels);
  const mergeableUnchanged =
    existing.mergeable === null
      ? observed.mergeable === null
      : observed.mergeable !== null && asBool(existing.mergeable) === observed.mergeable;
  const unchanged =
    existing.head_sha === observed.headSha &&
    existing.state === observed.state &&
    existing.review_state === observed.reviewState &&
    existing.ci_status === observed.ciStatus &&
    mergeableUnchanged &&
    labelsEqual(existing.blocking_labels, observed.blockingLabels) &&
    asBool(existing.conversations_resolved) === observed.conversationsResolved &&
    timestampsEqual(existing.merged_at, observed.mergedAt) &&
    existing.merge_sha === observed.mergeSha &&
    timestampsEqual(existing.closed_at, observed.closedAt);
  if (unchanged) return;

  await tx.execute(
    `UPDATE pull_requests
       SET head_sha = ?, state = ?, review_state = ?, ci_status = ?, mergeable = ?,
           blocking_labels = ?, conversations_resolved = ?, merged_at = ?, merge_sha = ?,
           closed_at = ?, version = version + 1, updated_at = ?
     WHERE feature_run_id = ?`,
    [
      observed.headSha,
      observed.state,
      observed.reviewState,
      observed.ciStatus,
      observed.mergeable === null ? null : observed.mergeable ? 1 : 0,
      observedBlockingLabels,
      observed.conversationsResolved ? 1 : 0,
      observed.mergedAt,
      observed.mergeSha,
      observed.closedAt,
      isoNow(),
      featureRunId,
    ],
  );
}

// Exported for direct unit testing of MEDIUM-1's cross-dialect normalization (see
// packages/testing/src/pull-request-row.test.ts) — not otherwise part of this module's public API.
export { labelsEqual, timestampsEqual };

export { generateId };
