/**
 * Small, injected LLM-review seam (docs/06 Phase 10 "Design decisions" #1 — mirroring
 * `@minicoder/adapters-coder`'s `CodeGenerationProvider` seam from Phase 9). Ship exactly one
 * concrete implementation (`HttpReviewProvider`, a plain-fetch OpenAI-compatible client); tests
 * use a deterministic fake of this interface instead of a real API.
 *
 * Unlike `CodeGenerationProvider`, there is no sandbox involved at all here — reviewing a PR is
 * read-only (no code execution, no container isolation required), a real simplification versus
 * Phase 9's `CodexCoderAdapter`.
 */
export interface ReviewRequest {
  readonly featureTitle: string;
  readonly acceptanceCriteria: readonly string[];
  readonly diff: string;
  readonly correlationId: string;
}

export interface ReviewFindingRaw {
  readonly severity:
    | 'blocking'
    | 'non_blocking'
    | 'nit'
    | 'question'
    | 'out_of_scope'
    | 'requires_human_decision';
  readonly category: string;
  readonly description: string;
  readonly filePath?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

export interface ReviewResult {
  readonly decision: 'approved' | 'changes_requested';
  readonly findings: readonly ReviewFindingRaw[];
  readonly tokensUsed?: { readonly input: number; readonly output: number };
  /** The exact assembled prompt/request sent to the LLM provider (issue #49 — audit provenance:
   * if a review's findings are later disputed, this lets an operator reconstruct exactly what the
   * reviewer was shown). Structured, not a raw string, so the caller's existing
   * `SecretRedactor.redactObject()` pass can scrub it the same way every other persisted
   * input/output is scrubbed. */
  readonly promptSnapshot?: unknown;
}

export interface ReviewProvider {
  review(request: ReviewRequest): Promise<ReviewResult>;
}
