import type {
  DocumentationAgentAdapter,
  DocumentationInput,
  DocumentationOutput,
} from '@minicoder/core';
import { DESIGN_DOCUMENT_SECTION_NAMES, generateId } from '@minicoder/core';
import type { DocumentationProvider } from './documentation-provider.js';

export interface ClaudeDocumentationAdapterOptions {
  readonly documentationProvider: DocumentationProvider;
  /** Evidence beyond the narrow `DocumentationInput` contract (project name/description, feature
   * summaries, merged PR count) — supplied by the caller (`run-design-doc.ts`) from
   * `collectDesignDocumentEvidence()`, the same "adapter contract stays narrow, caller enriches
   * via constructor options" shape `ClaudeReviewerAdapter` uses for `owner`/`repo`. */
  readonly projectName: string;
  readonly projectDescription: string | null;
  readonly featureSummaries: readonly string[];
  readonly mergedPullRequestCount: number;
}

export interface ClaudeDocumentationOutput extends DocumentationOutput {
  readonly tokensUsed?: { readonly input: number; readonly output: number };
}

/**
 * Reference `DocumentationAgentAdapter` implementation (Phase 17), mirroring
 * `ClaudeReviewerAdapter`'s exact shape: sandbox-free, a single injected `DocumentationProvider`
 * seam, no vendor SDK. Drafting the final design document is read-only (no code execution), so
 * — like the Reviewer adapter — there is no container isolation to create/tear down.
 */
export class ClaudeDocumentationAdapter implements DocumentationAgentAdapter {
  readonly role = 'DocumentationAgentAdapter' as const;

  constructor(private readonly options: ClaudeDocumentationAdapterOptions) {}

  async run(input: DocumentationInput): Promise<ClaudeDocumentationOutput> {
    const result = await this.options.documentationProvider.draft({
      projectName: this.options.projectName,
      projectDescription: this.options.projectDescription,
      featureSummaries: this.options.featureSummaries,
      mergedPullRequestCount: this.options.mergedPullRequestCount,
      sectionNames: DESIGN_DOCUMENT_SECTION_NAMES,
      correlationId: input.correlationId,
    });

    const bySectionName = new Map(result.sections.map((s) => [s.sectionName, s.content]));
    const sections = DESIGN_DOCUMENT_SECTION_NAMES.map((sectionName) => ({
      sectionName,
      content: bySectionName.get(sectionName) ?? `(no content drafted for ${sectionName})`,
    }));

    return {
      documentId: generateId(),
      sections,
      requiresRevision: false,
      tokensUsed: result.tokensUsed,
    };
  }
}
