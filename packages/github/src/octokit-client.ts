/**
 * OctokitGitHubClient — the real, Octokit-backed implementation of the `GitHubClient` seam
 * defined in `packages/core/src/github/client.ts`. Core stays provider-SDK-free; this is the
 * only place in the codebase that imports Octokit.
 *
 * Auth: a GitHub App installation token is preferred (docs/07-security-and-secrets.md §3); a
 * personal access token (`GITHUB_TOKEN`) is supported for local/single-node development.
 */

import { Octokit } from '@octokit/rest';
import type {
  CreateBranchOptions,
  CreatePullRequestOptions,
  GitHubClient,
  ObservedPullRequestState,
  PublishStatusCheckOptions,
} from '@minicoder/core';
import { PrReviewState } from '@minicoder/core';

export interface OctokitGitHubClientOptions {
  /** Installation token (preferred) or PAT. */
  auth: string;
}

export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;

  constructor(options: OctokitGitHubClientOptions) {
    this.octokit = new Octokit({ auth: options.auth });
  }

  async createBranch(options: CreateBranchOptions): Promise<{ branchName: string; sha: string }> {
    await this.octokit.git.createRef({
      owner: options.owner,
      repo: options.repo,
      ref: `refs/heads/${options.branchName}`,
      sha: options.fromSha,
    });
    return { branchName: options.branchName, sha: options.fromSha };
  }

  async createPullRequest(
    options: CreatePullRequestOptions,
  ): Promise<{ prNumber: number; branchName: string }> {
    const { data } = await this.octokit.pulls.create({
      owner: options.owner,
      repo: options.repo,
      head: options.branchName,
      base: options.baseBranch,
      title: options.title,
      body: options.body,
    });
    return { prNumber: data.number, branchName: options.branchName };
  }

  async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ObservedPullRequestState | null> {
    let pr;
    try {
      const res = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });
      pr = res.data;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      throw err;
    }

    const [reviews, checkRuns, combinedStatus] = await Promise.all([
      this.octokit.pulls.listReviews({ owner, repo, pull_number: prNumber }),
      this.octokit.checks.listForRef({ owner, repo, ref: pr.head.sha }),
      this.octokit.repos.getCombinedStatusForRef({ owner, repo, ref: pr.head.sha }),
    ]);

    return {
      prNumber: pr.number,
      branchName: pr.head.ref,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      state: pr.merged ? 'merged' : (pr.state as 'open' | 'closed'),
      reviewState: deriveReviewState(reviews.data),
      ciStatus: deriveCiStatus(checkRuns.data.check_runs, combinedStatus.data),
      mergeable: pr.mergeable ?? null,
      blockingLabels: (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
      // HIGH-4 code-review fix: GitHub's REST API has no "conversations resolved" flag at all —
      // only GraphQL's `reviewThreads.nodes[].isResolved` exposes it, and implementing GraphQL
      // support is out of proportion for this fix. This is a conservative fail-closed placeholder
      // (nothing in the codebase currently gates a merge/review decision on this field), not a
      // real observation — a future merge-gate consumer (Phase 12) must not treat "unknown" as
      // "resolved" by relying on this value until GraphQL support lands.
      conversationsResolved: false,
      mergedAt: pr.merged_at ?? null,
      mergeSha: pr.merge_commit_sha ?? null,
      closedAt: pr.closed_at ?? null,
    };
  }

  async publishStatusCheck(options: PublishStatusCheckOptions): Promise<void> {
    await this.octokit.repos.createCommitStatus({
      owner: options.owner,
      repo: options.repo,
      sha: options.sha,
      context: options.context,
      state: options.state,
      description: options.description,
      target_url: options.targetUrl,
    });
  }

  async getRemainingRateLimit(): Promise<number> {
    const { data } = await this.octokit.rateLimit.get();
    return data.resources.core.remaining;
  }
}

/**
 * HIGH-3 code-review fix: reduces to each reviewer's *latest* review first (grouped by
 * `user.login`), then applies per-reviewer blocking semantics, instead of sorting all reviews
 * globally and taking the single latest review across all reviewers. The prior global-latest
 * approach let a later APPROVED from one reviewer (e.g. Bob) silently clear an earlier, still
 * outstanding CHANGES_REQUESTED from another reviewer (e.g. Alice) — incorrectly reporting the PR
 * as approved. Precedence, once reduced to one verdict per reviewer: any reviewer whose latest
 * review is still CHANGES_REQUESTED blocks the whole PR; else APPROVED if any reviewer's latest is
 * APPROVED; else COMMENTED / DISMISSED / PENDING in that fallback order (matching the existing
 * per-state mapping), based on the single most recent review overall when no reviewer is currently
 * blocking or approving.
 */
export function deriveReviewState(
  reviews: Array<{
    state: string;
    submitted_at?: string | null;
    user?: { login?: string | null } | null;
  }>,
): ObservedPullRequestState['reviewState'] {
  if (reviews.length === 0) return PrReviewState.NONE;

  const sorted = [...reviews].sort(
    (a, b) => new Date(a.submitted_at ?? 0).getTime() - new Date(b.submitted_at ?? 0).getTime(),
  );

  // Reduce to each reviewer's latest review (later entries in `sorted` overwrite earlier ones for
  // the same login). Reviews with no identifiable reviewer login each count as their own
  // "reviewer" (keyed by array index) so they still participate in the fallback ordering below
  // without colliding with each other.
  const latestByReviewer = new Map<string, { state: string; submitted_at?: string | null }>();
  sorted.forEach((review, index) => {
    const key = review.user?.login ?? `__unknown_${index}`;
    latestByReviewer.set(key, review);
  });
  const latestReviews = [...latestByReviewer.values()];

  if (latestReviews.some((r) => r.state === 'CHANGES_REQUESTED')) {
    return PrReviewState.CHANGES_REQUESTED;
  }
  if (latestReviews.some((r) => r.state === 'APPROVED')) {
    return PrReviewState.APPROVED;
  }

  const last = sorted[sorted.length - 1];
  switch (last?.state) {
    case 'COMMENTED':
      return PrReviewState.COMMENTED;
    case 'DISMISSED':
      return PrReviewState.DISMISSED;
    default:
      return PrReviewState.PENDING;
  }
}

/**
 * Combines GitHub Checks (checkRuns) with the legacy combined commit-status API
 * (`repos.getCombinedStatusForRef`) so `OctokitGitHubClient` derives correct CI status for repos
 * using either signal, or both (HIGH-4 code-review fix — the `status` webhook event has no
 * Checks-API equivalent). Precedence, evaluated across both sources together: a failure from
 * either wins outright ('failed'); otherwise pending/in-progress from either wins next
 * ('running'); otherwise a success from at least one (with neither failure nor pending present)
 * is 'passed'; otherwise (no signal from either source) 'pending'.
 */
export function deriveCiStatus(
  checkRuns: Array<{ status: string; conclusion: string | null }>,
  combinedStatus: { state: string; total_count?: number },
): ObservedPullRequestState['ciStatus'] {
  const hasCheckRuns = checkRuns.length > 0;
  const hasCommitStatuses = (combinedStatus.total_count ?? 0) > 0;
  if (!hasCheckRuns && !hasCommitStatuses) return 'pending';

  const checkFailed = checkRuns.some((c) => c.status === 'completed' && c.conclusion !== 'success');
  const statusFailed =
    hasCommitStatuses && (combinedStatus.state === 'failure' || combinedStatus.state === 'error');
  if (checkFailed || statusFailed) return 'failed';

  const checkRunning = checkRuns.some((c) => c.status !== 'completed');
  const statusPending = hasCommitStatuses && combinedStatus.state === 'pending';
  if (checkRunning || statusPending) return 'running';

  const checkPassed = hasCheckRuns && checkRuns.every((c) => c.conclusion === 'success');
  const statusPassed = hasCommitStatuses && combinedStatus.state === 'success';
  if (checkPassed || statusPassed) return 'passed';

  return 'pending';
}
