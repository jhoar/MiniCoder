import type {
  GitHubClient,
  ReviewerAgentAdapter,
  ReviewerInput,
  ReviewerOutput,
} from '@minicoder/core';
import type { ReviewProvider } from './review-provider.js';

export interface ClaudeReviewerAdapterOptions {
  readonly owner: string;
  readonly repo: string;
  readonly githubClient: GitHubClient;
  readonly reviewProvider: ReviewProvider;
}

/** `ReviewerOutput` plus token usage — mirrors `CodexCoderOutput extends CoderOutput`
 * (`@minicoder/adapters-coder`) so `run-review.ts` can fold token usage into a `costExtractor`
 * the same way `run-coder.ts` does. */
export interface ClaudeReviewerOutput extends ReviewerOutput {
  readonly tokensUsed?: { readonly input: number; readonly output: number };
}

/**
 * Reference `ReviewerAgentAdapter` implementation (docs/06 Phase 10). Unlike
 * `CodexCoderAdapter`, this adapter needs **no sandbox** — reviewing a pull request is read-only
 * (fetch the diff, ask an LLM, return findings), so there is no code execution or container
 * isolation to isolate. It calls `ReviewProvider` directly from the Trigger.dev task process
 * (`run-review.ts`), the same host-side-call posture Phase 9's `CodexCoderAdapter` documents for
 * its own LLM call (docs/07 §6 "Phase 9 implementation status").
 *
 * Single-normalization-point design (Phase 10): this adapter deliberately does **not** call
 * `normalizeReviewerFindings()` itself — it maps the provider's raw response into
 * `ReviewFindingOutput` shape and returns it as-is. `run-review.ts` (the sole caller) normalizes
 * once, uniformly, for every adapter (this one or a test `MockReviewerAdapter`), rather than
 * splitting normalization across two places.
 */
export class ClaudeReviewerAdapter implements ReviewerAgentAdapter {
  readonly role = 'ReviewerAgentAdapter' as const;

  constructor(private readonly options: ClaudeReviewerAdapterOptions) {}

  async run(input: ReviewerInput): Promise<ClaudeReviewerOutput> {
    const diff = await this.options.githubClient.getPullRequestDiff(
      this.options.owner,
      this.options.repo,
      input.prNumber,
    );

    // ReviewerInput (Phase 5's adapter contract) carries no featureTitle/acceptanceCriteria
    // fields — only identifiers (projectId/featureRunId/prNumber/reviewCycle/correlationId).
    // Widening that shared contract just for this one adapter's prompt was considered and
    // rejected (it would ripple into every other ReviewerAgentAdapter caller and
    // MockReviewerAdapter); the diff itself carries the substantive review content.
    const result = await this.options.reviewProvider.review({
      featureTitle: `feature run ${input.featureRunId}`,
      acceptanceCriteria: [],
      diff,
      correlationId: input.correlationId,
    });

    return {
      decision: result.decision,
      findings: result.findings.map((finding) => ({
        severity: finding.severity,
        category: finding.category,
        description: finding.description,
        filePath: finding.filePath,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
      })),
      tokensUsed: result.tokensUsed,
    };
  }
}
