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
  blocking_labels: string;
  conversations_resolved: number | boolean;
  merged_at: string | null;
  merge_sha: string | null;
  closed_at: string | null;
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

/**
 * Full observed-state mirror sync (HIGH-3 / MEDIUM-1 code-review fix): writes every
 * GitHub-observed column onto the existing `pull_requests` row for `featureRunId`, not just
 * `ci_status`/`review_state` — `head_sha`, `state`, `mergeable`, `blocking_labels`,
 * `conversations_resolved`, `merged_at`, `merge_sha`, `closed_at` all land here too, whatever
 * `review_state` GitHub reports (`approved`/`commented`/`dismissed`/`changes_requested`/`none`),
 * not just `changes_requested`. This is a no-op (0 rows affected) if no `pull_requests` row exists
 * yet for `featureRunId` — `reconcileGithubState` calls this unconditionally before any action
 * branch, and the `code_pushed -> pr_opened` branch is responsible for first creating the row via
 * `insertPullRequestRow`. Superseded `updatePullRequestCiStatus`/`updatePullRequestReviewState`
 * single-column writes remain exported for now but are no longer called by the Record* handlers,
 * which rely on this full sync instead.
 */
export async function syncPullRequestObservedState(
  tx: TxClient,
  featureRunId: string,
  observed: ObservedPullRequestState,
): Promise<void> {
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
      JSON.stringify(observed.blockingLabels),
      observed.conversationsResolved ? 1 : 0,
      observed.mergedAt,
      observed.mergeSha,
      observed.closedAt,
      isoNow(),
      featureRunId,
    ],
  );
}

export { generateId };
