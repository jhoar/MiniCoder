import type {
  CreateBranchOptions,
  CreatePullRequestOptions,
  GitHubClient,
  ObservedPullRequestState,
} from '@minicoder/core';
import { PrReviewState } from '@minicoder/core';
import type { MockGitHubProvider, MockPrState } from './mock-github-provider.js';

/**
 * Deterministic test seam for `GitHubClient` (packages/core/src/github/client.ts), parallel to
 * `MockGitHubProvider`'s simulate-* CLI-facing surface. Wraps a `MockGitHubProvider` instance so
 * scenario tests can drive GitHub state via `simulatePrOpened`/`simulateCheckPassed`/etc. and have
 * `reconcileGithubState` observe it through the same `GitHubClient` interface the real
 * `OctokitGitHubClient` implements — no live GitHub calls (docs/04 §3.2 "Mock Providers by
 * Default").
 *
 * `createBranch`/`createPullRequest` (Phase 9): real deterministic in-memory recorders rather
 * than throwing stubs, since the `run-coder` task is now a real production caller of both.
 * `createPullRequest` also registers the PR into the wrapped `MockGitHubProvider` (deriving the
 * feature-run id from the `minicoder/<featureRunId>` branch-naming convention — docs/00 §3.11) so
 * `getPullRequest`/`reconcileGithubState` observe it exactly as they would a real GitHub PR.
 */
export class MockGitHubClient implements GitHubClient {
  readonly branches: Array<CreateBranchOptions> = [];
  readonly pullRequests: Array<CreatePullRequestOptions & { prNumber: number }> = [];
  private nextPrNumber = 1;

  constructor(private readonly provider: MockGitHubProvider) {}

  async createBranch(options: CreateBranchOptions): Promise<{ branchName: string; sha: string }> {
    this.branches.push(options);
    return { branchName: options.branchName, sha: options.fromSha };
  }

  async createPullRequest(
    options: CreatePullRequestOptions,
  ): Promise<{ prNumber: number; branchName: string }> {
    const prNumber = this.nextPrNumber++;
    this.pullRequests.push({ ...options, prNumber });

    const featureRunId = options.branchName.startsWith('minicoder/')
      ? options.branchName.slice('minicoder/'.length)
      : options.branchName;
    const priorBranch = [...this.branches]
      .reverse()
      .find((b) => b.branchName === options.branchName);
    this.provider.simulatePrOpened(prNumber, featureRunId, priorBranch?.fromSha ?? 'mock-head-sha');

    return { prNumber, branchName: options.branchName };
  }

  async getPullRequest(
    _owner: string,
    _repo: string,
    prNumber: number,
  ): Promise<ObservedPullRequestState | null> {
    const pr = this.provider.getPrState(prNumber);
    if (!pr) return null;
    return toObservedState(pr);
  }

  async publishStatusCheck(): Promise<void> {
    // No-op: MockGitHubProvider does not model status-check publication.
  }

  async getRemainingRateLimit(): Promise<number> {
    return 5000;
  }
}

function toObservedState(pr: MockPrState): ObservedPullRequestState {
  return {
    prNumber: pr.prNumber,
    branchName: `minicoder/${pr.featureRunId ?? 'unknown'}`,
    baseBranch: 'main',
    headSha: pr.headSha,
    state: pr.state,
    reviewState: deriveReviewState(pr.reviews),
    ciStatus: deriveCiStatus(pr.checks),
    mergeable: pr.state === 'open' ? true : null,
    blockingLabels: [],
    conversationsResolved: true,
    mergedAt: pr.mergedAt,
    mergeSha: pr.mergeSha,
    closedAt: pr.state === 'closed' || pr.state === 'merged' ? new Date().toISOString() : null,
  };
}

function deriveReviewState(
  reviews: MockPrState['reviews'],
): ObservedPullRequestState['reviewState'] {
  if (reviews.length === 0) return PrReviewState.NONE;
  const last = reviews[reviews.length - 1];
  return last?.state === 'approved' ? PrReviewState.APPROVED : PrReviewState.CHANGES_REQUESTED;
}

function deriveCiStatus(checks: MockPrState['checks']): ObservedPullRequestState['ciStatus'] {
  if (checks.length === 0) return 'pending';
  if (checks.some((c) => c.state === 'failed')) return 'failed';
  return 'passed';
}
