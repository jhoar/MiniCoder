/**
 * Small, injected LLM-drafting seam (mirrors `@minicoder/adapters-reviewer`'s `ReviewProvider`
 * and `@minicoder/adapters-arbiter`'s `ArbiterProvider` exactly). Ship exactly one concrete
 * implementation (`HttpDocumentationProvider`, a plain-fetch OpenAI-compatible client); tests use
 * a deterministic fake of this interface instead of a real API. No sandbox involved — drafting
 * design-document prose from already-collected DB evidence is read-only, the same simplification
 * `ClaudeReviewerAdapter` documents versus `CodexCoderAdapter`.
 */
export interface DocumentationSectionRequest {
  readonly sectionName: string;
  readonly sectionNames: readonly string[];
}

export interface DocumentationRequest {
  readonly projectName: string;
  readonly projectDescription: string | null;
  readonly featureSummaries: readonly string[];
  readonly mergedPullRequestCount: number;
  readonly sectionNames: readonly string[];
  readonly correlationId: string;
}

export interface DocumentationSectionResult {
  readonly sectionName: string;
  readonly content: string;
}

export interface DocumentationResult {
  readonly sections: readonly DocumentationSectionResult[];
  readonly tokensUsed?: { readonly input: number; readonly output: number };
}

export interface DocumentationProvider {
  draft(request: DocumentationRequest): Promise<DocumentationResult>;
}
