/**
 * GitHubClient — the provider-facing seam for GitHub-observed state (docs/01 §5.7).
 *
 * Orchestrator Core is provider-SDK-free (CLAUDE.md "Key Architectural Decisions" #7): this
 * interface has no Octokit import. The real implementation (`OctokitGitHubClient`) lives in
 * `packages/github`; `MockGitHubClient` (packages/testing) is the deterministic test seam.
 * Reconciliation logic in core consumes only this interface and an already-fetched
 * `ObservedPullRequestState` — it never calls a provider SDK directly.
 */

import type { PrReviewState } from '../domain/states.js';

/** GitHub's PR-level open/closed/merged state (distinct from the review state). */
export type GithubPrState = 'open' | 'closed' | 'merged';

/** CI status mirrored onto pull_requests.ci_status. */
export type GithubCiStatus = 'pending' | 'running' | 'passed' | 'failed';

/**
 * Observed, already-fetched GitHub state for a single pull request. Callers (webhook inbox
 * handlers, the scheduled reconciliation task) fetch this via GitHubClient *before* invoking the
 * shared reconciliation function in core — core itself never talks to GitHub.
 */
export interface ObservedPullRequestState {
  prNumber: number;
  branchName: string;
  baseBranch: string;
  headSha: string | null;
  state: GithubPrState;
  reviewState: PrReviewState;
  ciStatus: GithubCiStatus;
  mergeable: boolean | null;
  blockingLabels: string[];
  conversationsResolved: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  closedAt: string | null;
}

export interface CreateBranchOptions {
  owner: string;
  repo: string;
  branchName: string;
  fromSha: string;
}

export interface CreatePullRequestOptions {
  owner: string;
  repo: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body?: string;
}

export interface PublishStatusCheckOptions {
  owner: string;
  repo: string;
  sha: string;
  /** Always 'minicoder/review-gate' per docs/00-glossary-and-terms.md §3.11. */
  context: string;
  state: 'pending' | 'success' | 'failure' | 'error';
  description?: string;
  targetUrl?: string;
}

/** GitHub API client seam. Real implementation is Octokit-backed (`packages/github`). */
export interface GitHubClient {
  createBranch(options: CreateBranchOptions): Promise<{ branchName: string; sha: string }>;

  createPullRequest(
    options: CreatePullRequestOptions,
  ): Promise<{ prNumber: number; branchName: string }>;

  /** Fetch current authoritative state for a PR: branch, CI, reviews, mergeability, labels. */
  getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ObservedPullRequestState | null>;

  publishStatusCheck(options: PublishStatusCheckOptions): Promise<void>;

  /** Remaining GitHub API rate-limit budget, for the capacity pre-flight check. */
  getRemainingRateLimit(): Promise<number>;

  /**
   * Unified diff text for a pull request (Phase 10 — Reviewer adapter). Reviewing a PR is
   * read-only, unlike Coder's clone/commit/push, so this is the only new GitHub-facing method
   * this phase adds — no sandbox, no local git checkout required.
   */
  getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string>;
}
