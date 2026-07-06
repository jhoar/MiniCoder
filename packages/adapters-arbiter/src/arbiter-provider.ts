/**
 * Small, injected LLM-arbitration seam (issue #51), mirroring
 * `@minicoder/adapters-reviewer`'s `ReviewProvider` seam exactly: ship exactly one concrete
 * implementation (`HttpArbiterProvider`, a plain-fetch OpenAI-compatible client); tests use a
 * deterministic fake of this interface instead of a real API. No sandbox is involved —
 * arbitrating a coder/reviewer disagreement is a read/generate-only LLM call over already-supplied
 * text (`ArbiterInput.findingDescription`/`coderPosition`/`reviewerPosition`), the same posture
 * `ReviewProvider` already established.
 */
export interface ArbitrationRequest {
  readonly findingDescription: string;
  readonly coderPosition: string;
  readonly reviewerPosition: string;
  readonly correlationId: string;
}

export interface ArbitrationResult {
  readonly resolution: 'coder_correct' | 'reviewer_correct' | 'compromise' | 'escalate_to_human';
  readonly notes: string;
  readonly tokensUsed?: { readonly input: number; readonly output: number };
  readonly promptSnapshot?: unknown;
}

export interface ArbiterProvider {
  arbitrate(request: ArbitrationRequest): Promise<ArbitrationResult>;
}
