import type { DbClient, TxClient } from '../persistence/types.js';
import type { ReviewFindingInsert } from '../review/normalize-findings.js';

export interface RepeatedFindingMatch {
  readonly priorFindingId: string;
  readonly priorReviewCycle: number;
  readonly description: string;
}

/**
 * Detects "repeated unresolved findings" (docs/01 §5.9, docs/06 Phase 11): the same substantive
 * blocking/requires_human_decision finding recurring across review cycles for a feature run —
 * the signal that the CoderAgentAdapter's fix attempt did not actually satisfy the
 * ReviewerAgentAdapter, i.e. a genuine coder/reviewer disagreement rather than a normal one-shot
 * fix cycle.
 *
 * A push always resolves every currently-open finding optimistically (docs/06 Phase 10's
 * "optimistic fixed" design decision — `RecordCodePushedHandler`), so a recurring problem never
 * shows up as the same `review_findings` row reopened; it shows up as a *new* row in a later
 * `review_cycle` with the same `description`. Matching on exact description text (trimmed) across
 * cycles is therefore the correct, and only available, repeat signal — there is no per-finding
 * fingerprint/hash column in the schema.
 *
 * Only matches prior findings from a *lower* review cycle than the one about to be written, and
 * only compares against `blocking`/`requires_human_decision` severities (a repeated `nit` isn't a
 * disagreement worth arbitrating).
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
    .filter((f) => f.severity === 'blocking' || f.severity === 'requires_human_decision')
    .map((f) => f.description.trim());
  if (candidateDescriptions.length === 0) return null;

  const rows = await db.query<{ id: string; description: string; review_cycle: number }>(
    `SELECT id, description, review_cycle FROM review_findings
     WHERE feature_run_id = ?
       AND review_cycle < ?
       AND severity IN ('blocking', 'requires_human_decision')
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
