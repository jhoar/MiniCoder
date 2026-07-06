import { describe, it, expect } from 'vitest';
import type { GitHubClient, ReviewerInput } from '@minicoder/core';
import { ClaudeReviewerAdapter } from './claude-reviewer-adapter.js';
import type { ReviewProvider, ReviewRequest } from './review-provider.js';

function fakeGithubClient(diff: string): GitHubClient {
  return {
    async createBranch() {
      return { branchName: 'x', sha: 'abc' };
    },
    async createPullRequest() {
      throw new Error('not used');
    },
    async mergePullRequest() {
      throw new Error('not used');
    },
    async getPullRequest() {
      return null;
    },
    async publishStatusCheck() {},
    async getRemainingRateLimit() {
      return 5000;
    },
    async getPullRequestDiff() {
      return diff;
    },
  };
}

function baseInput(overrides: Partial<ReviewerInput> = {}): ReviewerInput {
  return {
    projectId: 'proj-1',
    featureRunId: 'run-1',
    prNumber: 7,
    reviewCycle: 1,
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('ClaudeReviewerAdapter', () => {
  it('passes the real featureTitle/acceptanceCriteria through to the review provider (issue #47)', async () => {
    let seenRequest: ReviewRequest | undefined;
    const provider: ReviewProvider = {
      async review(request) {
        seenRequest = request;
        return { decision: 'approved', findings: [] };
      },
    };
    const adapter = new ClaudeReviewerAdapter({
      owner: 'o',
      repo: 'r',
      githubClient: fakeGithubClient('diff --git a/x b/x\n'),
      reviewProvider: provider,
    });

    await adapter.run(
      baseInput({
        featureTitle: 'Add todo creation',
        acceptanceCriteria: ['A user can create a todo.', 'The todo persists.'],
      }),
    );

    expect(seenRequest?.featureTitle).toBe('Add todo creation');
    expect(seenRequest?.acceptanceCriteria).toEqual([
      'A user can create a todo.',
      'The todo persists.',
    ]);
  });

  it('falls back to a synthesized title/empty criteria when the input does not supply them', async () => {
    let seenRequest: ReviewRequest | undefined;
    const provider: ReviewProvider = {
      async review(request) {
        seenRequest = request;
        return { decision: 'approved', findings: [] };
      },
    };
    const adapter = new ClaudeReviewerAdapter({
      owner: 'o',
      repo: 'r',
      githubClient: fakeGithubClient('diff --git a/x b/x\n'),
      reviewProvider: provider,
    });

    await adapter.run(baseInput());

    expect(seenRequest?.featureTitle).toBe('feature run run-1');
    expect(seenRequest?.acceptanceCriteria).toEqual([]);
  });
});
