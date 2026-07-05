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
  MergePullRequestOptions,
  ObservedPullRequestState,
  PublishStatusCheckOptions,
} from '@minicoder/core';
import { GithubMergeRejectedError, PrReviewState } from '@minicoder/core';
import { classifyCheckConclusion } from './check-conclusion.js';

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

    // HIGH-2 code-review fix: paginate both listReviews and checks.listForRef instead of a single
    // unpaginated page-1 call — a large PR (>30 reviews or >30 check runs, the default per-page
    // size) would otherwise silently drop later pages, hiding a blocking review or a failing check
    // run past page 1. `octokit.paginate` (built into @octokit/rest's core plugin set) auto-follows
    // `Link` headers and returns the already-flattened array — no `.data` unwrap needed. The
    // combined-status call is intentionally left unpaginated: GitHub's legacy combined-status
    // endpoint has no pagination support and is capped at 100 statuses by GitHub itself.
    // The `paginate` local re-types `this.octokit.paginate` to sidestep a type-only conflict
    // between the `@octokit/types` version `@octokit/plugin-paginate-rest` (bundled inside
    // `@octokit/rest@^19`, the CLAUDE.md-pinned major) expects for `RequestInterface` and the
    // slightly different `@octokit/types` version `Octokit`'s own generated endpoint methods
    // carry — both resolve at runtime to the same paginate-able Octokit request function; only the
    // structural type definitions disagree (a known `@octokit/types` duplicate-version hoisting
    // artifact, not a real API mismatch). The explicit result-array types on each call below (not
    // `unknown`/`any`) keep `deriveReviewState`/`deriveCiStatus`'s parameter types fully checked.
    const paginate = this.octokit.paginate as (
      method: unknown,
      params: Record<string, unknown>,
    ) => Promise<unknown[]>;
    const [reviews, checkRuns, combinedStatus] = await Promise.all([
      paginate(this.octokit.pulls.listReviews, { owner, repo, pull_number: prNumber }) as Promise<
        Array<{
          state: string;
          submitted_at?: string | null;
          user?: { login?: string | null } | null;
        }>
      >,
      paginate(this.octokit.checks.listForRef, { owner, repo, ref: pr.head.sha }) as Promise<
        Array<{ status: string; conclusion: string | null }>
      >,
      this.octokit.repos.getCombinedStatusForRef({ owner, repo, ref: pr.head.sha }),
    ]);

    return {
      prNumber: pr.number,
      branchName: pr.head.ref,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      state: pr.merged ? 'merged' : (pr.state as 'open' | 'closed'),
      reviewState: deriveReviewState(reviews),
      ciStatus: deriveCiStatus(checkRuns, combinedStatus.data),
      mergeable: pr.mergeable ?? null,
      // MEDIUM-2 code-review fix: this mirrors *every* label GitHub reports on the PR, not a
      // pre-filtered "merge-blocking" subset — there is no per-project blocking-label policy
      // defined anywhere in this codebase yet. Deciding which of these labels actually blocks
      // merge is explicit Phase 12 (Merge Gate) scope; a future implementer must add that
      // filtering there, not assume it already happened here.
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

  /**
   * Phase 12 — the only GitHub-facing call `minicoder merge merge-if-ready` makes. GitHub's
   * `sha` request param on `pulls.merge` is itself an optimistic-concurrency guard (a 409 if the
   * PR's real head has moved past `expectedHeadSha`); a 405 covers both branch-protection
   * rejection and a real merge conflict — GitHub does not distinguish the two in the response, so
   * both classify as the non-auto-clearable `'not_mergeable'` reason.
   */
  async mergePullRequest(options: MergePullRequestOptions): Promise<{ mergeSha: string }> {
    try {
      const { data } = await this.octokit.pulls.merge({
        owner: options.owner,
        repo: options.repo,
        pull_number: options.prNumber,
        merge_method: options.mergeMethod,
        commit_title: options.commitTitle,
        commit_message: options.commitMessage,
        sha: options.expectedHeadSha,
      });
      return { mergeSha: data.sha };
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 409) {
        throw new GithubMergeRejectedError(
          `PR #${options.prNumber} head moved since the merge gate was evaluated: ${message}`,
          'sha_mismatch',
          true,
        );
      }
      if (status === 405) {
        throw new GithubMergeRejectedError(
          `PR #${options.prNumber} is not mergeable (branch protection or conflict): ${message}`,
          'not_mergeable',
          false,
        );
      }
      // A genuine infrastructure/auth/validation failure (no HTTP status, or any status other
      // than the two known merge-policy rejections above — e.g. 401/403/404/422/429/5xx) is not
      // a merge-gate rejection at all — rethrow the original error so the caller fails loudly
      // instead of misrecording an operational failure as a merge_failed state transition
      // (code-review fix: this previously wrapped every other status into
      // `GithubMergeRejectedError('unknown', false)`, which drove `RecordMergeFailedCommand` +
      // `EscalateToHumanCommand` for e.g. a transient 500 or a bad-credentials 401).
      throw err;
    }
  }

  /**
   * Phase 10: uses Octokit's diff media type (`mediaType: { format: 'diff' }`), which makes
   * `response.data` a raw unified-diff string rather than the usual parsed PR object — @octokit/
   * rest@^19's generated types don't model this per-request override, hence the cast.
   */
  async getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    const response = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });
    return response.data as unknown as string;
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
 *
 * HIGH-1 code-review fix: "each reviewer's latest review" alone is not enough — a reviewer who
 * requested changes and *later left a COMMENTED review* (without approving or the review being
 * dismissed) still has an outstanding CHANGES_REQUESTED that GitHub itself continues to treat as
 * blocking, but taking only that reviewer's single latest review would overwrite the recorded
 * state with `commented`, silently clearing the block. Fix: walk the time-sorted reviews and track
 * a separate sticky per-reviewer "currently blocking" flag — set `true` by a CHANGES_REQUESTED
 * review, cleared (`false`) only by that same reviewer's later APPROVED or DISMISSED review; a
 * COMMENTED (or any other non-clearing) review from that reviewer leaves the flag untouched. If any
 * reviewer's sticky flag is still `true` after the walk, the result is `changes_requested`
 * regardless of what "latest review per reviewer" would otherwise report.
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
  // HIGH-1: sticky "currently blocking" flag per reviewer, independent of `latestByReviewer` above.
  const blockingByReviewer = new Map<string, boolean>();
  sorted.forEach((review, index) => {
    const key = review.user?.login ?? `__unknown_${index}`;
    latestByReviewer.set(key, review);
    if (review.state === 'CHANGES_REQUESTED') {
      blockingByReviewer.set(key, true);
    } else if (review.state === 'APPROVED' || review.state === 'DISMISSED') {
      blockingByReviewer.set(key, false);
    }
    // Any other state (e.g. COMMENTED) leaves this reviewer's sticky flag untouched.
  });
  const latestReviews = [...latestByReviewer.values()];
  const anyReviewerStillBlocking = [...blockingByReviewer.values()].some(Boolean);

  if (anyReviewerStillBlocking || latestReviews.some((r) => r.state === 'CHANGES_REQUESTED')) {
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
 * HIGH-4 code-review fix: GitHub's `conclusion` enum for a completed check run is not a binary
 * `success`/anything-else split. `neutral`, `skipped`, and `stale` are completed-but-not-failing
 * outcomes (GitHub itself does not treat them as failures), while `startup_failure` is a genuine
 * failure alongside `failure`/`timed_out`/`cancelled`/`action_required`. Classifying any
 * non-`success` conclusion as a failure (the prior `!== 'success'` check) incorrectly forced
 * `ci_status: 'failed'` for e.g. a `skipped` check run that has no bearing on merge readiness.
 *
 * MEDIUM-1 code-review fix (round 5): the classification itself now lives in the shared
 * `classifyCheckConclusion()` (`./check-conclusion.ts`), also imported by `normalize.ts`'s
 * `check_run`/`check_suite` webhook normalization — this was previously duplicated between the
 * two files and had drifted apart (`normalize.ts` never picked up this file's round-4 fix).
 */
function checkFailed(c: { status: string; conclusion: string | null }): boolean {
  return c.status === 'completed' && classifyCheckConclusion(c.conclusion) === 'failed';
}

function checkPassed(c: { status: string; conclusion: string | null }): boolean {
  return c.status === 'completed' && classifyCheckConclusion(c.conclusion) === 'passed';
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

  const anyCheckFailed = checkRuns.some(checkFailed);
  const statusFailed =
    hasCommitStatuses && (combinedStatus.state === 'failure' || combinedStatus.state === 'error');
  if (anyCheckFailed || statusFailed) return 'failed';

  const checkRunning = checkRuns.some((c) => c.status !== 'completed');
  const statusPending = hasCommitStatuses && combinedStatus.state === 'pending';
  if (checkRunning || statusPending) return 'running';

  // Nothing failed and nothing is still running/pending, and the top-of-function guard already
  // established that at least one of the two sources has a signal at all. In the overwhelming
  // majority of cases every check run here is `checkPassed` (a real success or a non-blocking
  // `neutral`/`skipped`/`stale` conclusion — anything else would already have matched
  // `checkFailed` above) and every commit status is non-failure/non-pending, so this reports
  // 'passed'. HIGH-4: a `neutral`/`skipped`/`stale` check run must not prevent an otherwise-clean
  // PR from being reported as 'passed'. (The `checkRunsPassed`/`statusPassed` re-check below is
  // defensive only — it guards a malformed API response with a `completed` check run that has a
  // `null` conclusion, which `checkFailed`/`checkPassed` both correctly refuse to classify as
  // passing.)
  const checkRunsPassed = checkRuns.every(checkPassed);
  const statusPassed = !hasCommitStatuses || combinedStatus.state === 'success';
  if (checkRunsPassed && statusPassed) return 'passed';

  return 'pending';
}
