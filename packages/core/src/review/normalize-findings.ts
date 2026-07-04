import { z } from 'zod';
import { FindingSeverity } from '../domain/states.js';
import type { ReviewerOutput, ReviewFindingOutput } from '../adapters/types.js';

/**
 * Insert-ready shape of a single review finding — validated via Zod so a malformed adapter
 * output (any adapter: `ClaudeReviewerAdapter` or a test `MockReviewerAdapter`) fails loudly
 * before ever reaching `insertReviewFindings()`, rather than persisting a corrupted row.
 */
export const ReviewFindingInsertSchema = z.object({
  severity: z.enum([
    FindingSeverity.BLOCKING,
    FindingSeverity.NON_BLOCKING,
    FindingSeverity.QUESTION,
    FindingSeverity.NIT,
    FindingSeverity.OUT_OF_SCOPE,
    FindingSeverity.REQUIRES_HUMAN_DECISION,
  ]),
  category: z.string().min(1),
  description: z.string().min(1),
  filePath: z.string().optional(),
  lineStart: z.number().int().nonnegative().optional(),
  lineEnd: z.number().int().nonnegative().optional(),
});
export type ReviewFindingInsert = z.infer<typeof ReviewFindingInsertSchema>;

/**
 * Single normalization point (Phase 10 design decision): every caller of a `ReviewerAgentAdapter`
 * — `run-review.ts`, regardless of which concrete adapter (`ClaudeReviewerAdapter` or a test
 * `MockReviewerAdapter`) produced the output — normalizes here before writing rows. The adapter
 * itself returns a raw `ReviewerOutput` mapped from its provider's response; it does not
 * normalize internally. This keeps exactly one place that validates/shapes review findings,
 * avoiding a double-normalization split between adapter and task.
 */
export function normalizeReviewerFindings(output: ReviewerOutput): ReviewFindingInsert[] {
  return output.findings.map((finding: ReviewFindingOutput) =>
    ReviewFindingInsertSchema.parse({
      severity: finding.severity,
      category: finding.category,
      description: finding.description,
      filePath: finding.filePath,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
    }),
  );
}
