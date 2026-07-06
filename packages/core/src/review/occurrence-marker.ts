import { isoNow } from '../commands/helpers.js';
import type { DbClient, TxClient } from '../persistence/types.js';

export interface ReviewOccurrenceMarker {
  readonly reviewCycle: number;
  readonly outcome: string;
}

/**
 * Deterministic, idempotent ledger for the review/fix loop's "clean review" path (issue #46) —
 * the one path with no state transition to atomically piggyback a `review_findings` write on (see
 * `insertReviewFindings()`'s doc comment for the blocking/escalation paths, which are already
 * atomic with their transition). Keyed by (featureRunId, headSha): the PR's head commit already
 * uniquely identifies "which diff was reviewed," so a retry can check this table *before*
 * invoking the reviewer adapter at all, rather than recomputing `reviewCycle = MAX(review_cycle)
 * + 1` and re-invoking the adapter for a commit that was already fully reviewed.
 */
export async function findReviewOccurrenceMarker(
  db: DbClient | TxClient,
  opts: { featureRunId: string; headSha: string },
): Promise<ReviewOccurrenceMarker | null> {
  const rows = await db.query<{ review_cycle: number; outcome: string }>(
    `SELECT review_cycle, outcome FROM review_occurrence_markers WHERE feature_run_id = ? AND head_sha = ?`,
    [opts.featureRunId, opts.headSha],
  );
  const row = rows[0];
  if (!row) return null;
  return { reviewCycle: row.review_cycle, outcome: row.outcome };
}

/**
 * Records that this exact (featureRunId, headSha) occurrence has been fully processed. Callers
 * must insert this in the same transaction as the corresponding `review_findings` write so a
 * crash between the two can't leave one without the other. `ON CONFLICT DO NOTHING` mirrors
 * `insertReviewFindings()`'s idempotent-retry pattern — a duplicate insert for the same
 * (featureRunId, headSha) is a no-op, not an error.
 */
export async function recordReviewOccurrenceMarker(
  db: DbClient | TxClient,
  opts: { featureRunId: string; headSha: string; reviewCycle: number; outcome: string },
): Promise<void> {
  const now = isoNow();
  await db.execute(
    `INSERT INTO review_occurrence_markers (id, feature_run_id, head_sha, review_cycle, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (feature_run_id, head_sha) DO NOTHING`,
    [
      `review-occurrence:${opts.featureRunId}:${opts.headSha}`,
      opts.featureRunId,
      opts.headSha,
      opts.reviewCycle,
      opts.outcome,
      now,
    ],
  );
}
