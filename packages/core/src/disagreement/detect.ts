import type { DbClient, TxClient } from '../persistence/types.js';
import type { ReviewFindingInsert } from '../review/normalize-findings.js';

export interface RepeatedFindingMatch {
  readonly priorFindingId: string;
  readonly priorReviewCycle: number;
  readonly description: string;
}

/**
 * Detects "repeated unresolved findings" (docs/01 §5.9, docs/06 Phase 11): the same substantive
 * `blocking` finding recurring across review cycles for a feature run — the signal that the
 * CoderAgentAdapter's fix attempt did not actually satisfy the ReviewerAgentAdapter, i.e. a
 * genuine coder/reviewer disagreement rather than a normal one-shot fix cycle.
 *
 * A push always resolves every currently-open finding optimistically (docs/06 Phase 10's
 * "optimistic fixed" design decision — `RecordCodePushedHandler`), so a recurring problem never
 * shows up as the same `review_findings` row reopened; it shows up as a *new* row in a later
 * `review_cycle` with the same `description`. Matching on exact description text (trimmed) across
 * cycles is therefore the correct, and only available, repeat signal — there is no per-finding
 * fingerprint/hash column in the schema.
 *
 * Only matches prior findings from a *lower* review cycle than the one about to be written, and
 * only compares against `blocking` severity. `requires_human_decision` is deliberately excluded:
 * `run-review.ts` escalates that severity unconditionally before this function is ever called
 * (the Reviewer's own explicit call that something is beyond automation scope), and second-guessing
 * that via the Arbiter would undermine the Reviewer's authority to make that call — the Arbiter's
 * role (docs/03 §5) is resolving coder/reviewer disagreement over a recurring `blocking` finding,
 * not vetting the Reviewer's decision to punt to a human. A repeated `nit`/`non_blocking` finding
 * likewise isn't a disagreement worth arbitrating.
 */
export async function findRepeatedFinding(
  db: DbClient | TxClient,
  opts: {
    featureRunId: string;
    reviewCycle: number;
    findings: readonly ReviewFindingInsert[];
  },
): Promise<RepeatedFindingMatch | null> {
  const candidateDescriptions = opts.findings
    .filter((f) => f.severity === 'blocking')
    .map((f) => f.description.trim());
  if (candidateDescriptions.length === 0) return null;

  const rows = await db.query<{ id: string; description: string; review_cycle: number }>(
    `SELECT id, description, review_cycle FROM review_findings
     WHERE feature_run_id = ?
       AND review_cycle < ?
       AND severity = 'blocking'
     ORDER BY review_cycle DESC`,
    [opts.featureRunId, opts.reviewCycle],
  );

  for (const row of rows) {
    if (candidateDescriptions.includes(row.description.trim())) {
      return {
        priorFindingId: row.id,
        priorReviewCycle: row.review_cycle,
        description: row.description,
      };
    }
  }
  return null;
}
