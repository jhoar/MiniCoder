import { isoNow } from '../commands/helpers.js';
import type { DbClient, TxClient } from '../persistence/types.js';
import type { ReviewFindingInsert } from './normalize-findings.js';

export interface InsertReviewFindingsOptions {
  readonly featureRunId: string;
  /** Null for CI-failure-originated findings (RecordCiFailedHandler) — there is no agent_runs
   * row backing a CI failure, only a real ReviewerAgentAdapter invocation has one. */
  readonly reviewerRunId: string | null;
  readonly reviewCycle: number;
  readonly findings: readonly ReviewFindingInsert[];
}

/**
 * Evidence-data writer for `review_findings` — not a `CommandHandler` (this isn't a
 * state-machine mutation, the same category as `agent_context_packs`/`agent_tool_operations`).
 * Deterministic ids (`review-finding:{featureRunId}:{reviewCycle}:{index}`) plus
 * `INSERT ... ON CONFLICT (id) DO NOTHING` make repeated calls with the same
 * (featureRunId, reviewCycle, findings) idempotent on retry — mirroring
 * `AdapterRegistry.register()`'s `ON CONFLICT DO NOTHING` pattern (CLAUDE.md's Agent Adapter
 * Operational Constraints) rather than SQLite-only `INSERT OR IGNORE`, so the same call works
 * against both dialects.
 */
export async function insertReviewFindings(
  db: DbClient | TxClient,
  opts: InsertReviewFindingsOptions,
): Promise<void> {
  const now = isoNow();
  for (const [index, finding] of opts.findings.entries()) {
    const id = `review-finding:${opts.featureRunId}:${opts.reviewCycle}:${index}`;
    // HIGH code-review fix (Phase 10, round 3): `resolved` is BOOLEAN in PostgreSQL
    // (migration 0001) — a bare integer literal `0` is rejected there ("column is of type
    // boolean but expression is of type integer"), even though SQLite accepts it since it has
    // no real boolean type. `FALSE`/`TRUE` SQL keywords are portable across both dialects
    // (SQLite has recognized them as literal synonyms for 0/1 since 3.23).
    await db.execute(
      `INSERT INTO review_findings
         (id, feature_run_id, reviewer_run_id, review_cycle, severity, category, description,
          file_path, line_start, line_end, resolved, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, 1, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        opts.featureRunId,
        opts.reviewerRunId,
        opts.reviewCycle,
        finding.severity,
        finding.category,
        finding.description,
        finding.filePath ?? null,
        finding.lineStart ?? null,
        finding.lineEnd ?? null,
        now,
        now,
      ],
    );
  }
}

/** Used to compute the id above; exported so callers needing to reference/resolve a just-written
 * finding row (e.g. run-coder.ts marking it resolved) don't have to duplicate the format. */
export function reviewFindingId(featureRunId: string, reviewCycle: number, index: number): string {
  return `review-finding:${featureRunId}:${reviewCycle}:${index}`;
}
