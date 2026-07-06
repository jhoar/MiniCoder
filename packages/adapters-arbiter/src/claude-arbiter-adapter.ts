import type { ArbiterAgentAdapter, ArbiterInput, ArbiterOutput } from '@minicoder/core';
import type { ArbiterProvider } from './arbiter-provider.js';

export interface ClaudeArbiterAdapterOptions {
  readonly arbiterProvider: ArbiterProvider;
}

/** `ArbiterOutput` plus token usage — mirrors `ClaudeReviewerOutput extends ReviewerOutput`
 * (`@minicoder/adapters-reviewer`) so `run-review.ts` can fold token usage into a `costExtractor`
 * the same way it already does for the reviewer invocation. `promptSnapshot` carries the exact
 * assembled request `ArbiterProvider.arbitrate()` sent, for replayable audit provenance, the same
 * pattern issue #49 established for the reviewer. */
export interface ClaudeArbiterOutput extends ArbiterOutput {
  readonly tokensUsed?: { readonly input: number; readonly output: number };
  readonly promptSnapshot?: unknown;
}

/**
 * Reference `ArbiterAgentAdapter` implementation (issue #51). Like `ClaudeReviewerAdapter`, this
 * adapter needs **no sandbox** — arbitrating a coder/reviewer disagreement is a read/generate-only
 * LLM call over text already assembled by `run-review.ts`
 * (`ArbiterInput.findingDescription`/`coderPosition`/`reviewerPosition`), so there is no code
 * execution or container isolation to isolate, and no diff to fetch (unlike the Reviewer, which
 * fetches the PR diff itself via `GitHubClient`).
 */
export class ClaudeArbiterAdapter implements ArbiterAgentAdapter {
  readonly role = 'ArbiterAgentAdapter' as const;

  constructor(private readonly options: ClaudeArbiterAdapterOptions) {}

  async run(input: ArbiterInput): Promise<ClaudeArbiterOutput> {
    const result = await this.options.arbiterProvider.arbitrate({
      findingDescription: input.findingDescription,
      coderPosition: input.coderPosition,
      reviewerPosition: input.reviewerPosition,
      correlationId: input.correlationId,
    });

    return {
      resolution: result.resolution,
      notes: result.notes,
      tokensUsed: result.tokensUsed,
      promptSnapshot: result.promptSnapshot,
    };
  }
}
