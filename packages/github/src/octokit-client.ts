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
      conversationsResolved: true, // GitHub's REST API has no direct "conversations resolved" flag; GraphQL is a future enhancement.
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

function deriveReviewState(
  reviews: Array<{ state: string; submitted_at?: string | null }>,
): ObservedPullRequestState['reviewState'] {
  if (reviews.length === 0) return PrReviewState.NONE;
  const sorted = [...reviews].sort(
    (a, b) => new Date(a.submitted_at ?? 0).getTime() - new Date(b.submitted_at ?? 0).getTime(),
  );
  const last = sorted[sorted.length - 1];
  switch (last?.state) {
    case 'APPROVED':
      return PrReviewState.APPROVED;
    case 'CHANGES_REQUESTED':
      return PrReviewState.CHANGES_REQUESTED;
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
