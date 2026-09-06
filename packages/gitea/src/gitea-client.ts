/**
 * GiteaScmClient — the Gitea-backed implementation of the `ScmClient` seam defined in
 * `packages/core/src/scm/client.ts` (docs/06 §Phase 18 Stage 3). Core stays provider-SDK-free;
 * this file (and `packages/gitea` generally) is the only place Gitea's REST API is spoken.
 *
 * No vendor SDK: Gitea's REST API is a plain JSON-over-HTTP API, so this client is a hand-rolled
 * `fetch`-based client (the injectable-`fetchImpl` seam already established by
 * `HttpCodeGenerationProvider`/`HttpReviewProvider`/etc.), not a wrapped third-party package —
 * there is no Gitea equivalent of Octokit's `@octokit/rest` in this codebase's dependency set.
 *
 * Self-hosted, so a `baseUrl` is required (unlike GitHub's fixed `api.github.com`) — this is
 * `repositories.base_url` (migration 0018) for a Gitea-provider repository row. Auth is a Gitea
 * personal/organization access token via the `Authorization: token <token>` scheme (Gitea's own
 * documented auth convention, distinct from GitHub App installation tokens — there is no Gitea
 * equivalent of a GitHub App).
 *
 * **Verification status (same honest-labeling posture CLAUDE.md already applies to the Coder
 * sandbox):** exercised end to end against a real, live Gitea 1.22.3 instance, both in a one-off
 * manual pass (docs/06 §Phase 18 Stage 6) and now permanently in CI (issue #85,
 * `packages/gitea/src/gitea-live.integration.test.ts`, `.github/workflows/live-scm-matrix.yml` —
 * scheduled + `workflow_dispatch`, not on every push). Unit tests still exercise this client
 * against a fake `fetchImpl` for everyday `pnpm test`/local dev; the live suite is what actually
 * proves this client's request/response handling against a real server's real behavior, not just
 * fixtures encoding today's assumptions about that behavior.
 *
 * Lowest-common-denominator reductions versus `OctokitGitHubClient`, documented here rather than
 * silently absorbed (per docs/06 §Phase 18's own framing — this is expected, not a defect):
 *   - `conversationsResolved` is a hardcoded `false` placeholder, the same starting point GitHub's
 *     own implementation had before issue #36 added a real GraphQL-backed observation — Gitea's
 *     REST API has no documented resolved-review-thread field, and Gitea has no GraphQL API at all
 *     to fall back to.
 *   - `getRemainingRateLimit()` returns a large sentinel — Gitea has no standard, always-available
 *     rate-limit-remaining endpoint the way GitHub does.
 *   - `mergePullRequest()`'s `expectedHeadSha` optimistic-concurrency guard is a no-op: Gitea's
 *     merge endpoint has no parameter for it, so this client can never produce
 *     `ScmMergeRejectedError`'s `'sha_mismatch'`/`autoClearable: true` classification — every
 *     rejected Gitea merge classifies as `'not_mergeable'`/`autoClearable: false`, which is the
 *     safe (if less automated) direction: it routes to human escalation rather than silently
 *     retrying against a PR whose head may have moved.
 *   - `listPullRequestsForBranch()` filters by head branch client-side after fetching a page of PRs
 *     in the requested state — Gitea's list-PRs endpoint has no documented server-side head-branch
 *     filter the way GitHub's `pulls.list({head})` does.
 */

import type {
  CreateBranchOptions,
  CreatePullRequestOptions,
  ScmPrState,
  ScmClient,
  MergePullRequestOptions,
  ObservedPullRequestState,
  PublishStatusCheckOptions,
} from '@minicoder/core';
import { ScmMergeRejectedError, PrReviewState } from '@minicoder/core';

export interface GiteaScmClientOptions {
  /** The Gitea instance's base URL, e.g. `https://gitea.example.com` (no trailing slash needed). */
  baseUrl: string;
  /** A Gitea personal or organization access token. */
  token: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** A non-2xx Gitea API response, carrying the HTTP status for caller-side classification. */
export class GiteaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'GiteaApiError';
  }
}

/** A large, non-`Infinity` sentinel — see this module's "getRemainingRateLimit" doc comment. */
const RATE_LIMIT_SENTINEL = Number.MAX_SAFE_INTEGER;

/** Bounded pagination — mirrors `OctokitGitHubClient`'s own defensive page caps. */
const MAX_PAGES = 20;
const PAGE_SIZE = 50;

interface GiteaPullRequest {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  closed_at: string | null;
  mergeable: boolean | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  labels?: Array<{ name?: string }> | null;
}

interface GiteaReview {
  state: string;
  submitted_at?: string | null;
  user?: { login?: string | null } | null;
}

interface GiteaCombinedStatus {
  state: string;
  statuses?: Array<{ state: string }>;
}

export class GiteaScmClient implements ScmClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GiteaScmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T | null }> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `token ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return { status: response.status, data: null };
    const text = await response.text();
    if (!response.ok) {
      // Gitea's structured error body ({errors, message, url}) explains *why* — e.g. "The target
      // couldn't be found" for an empty repository's PR routes, vs. a genuinely nonexistent repo —
      // and was previously discarded entirely, leaving only the bare HTTP status to debug from.
      let giteaMessage: string | null = null;
      try {
        const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { message?: unknown }).message === 'string'
        ) {
          giteaMessage = (parsed as { message: string }).message;
        }
      } catch {
        // Non-JSON error body (e.g. an HTML error page from a proxy in front of Gitea) — fall
        // back to the bare status rather than letting a parse failure mask the real HTTP error.
      }
      throw new GiteaApiError(
        `Gitea API ${method} ${path} failed with status ${response.status}` +
          (giteaMessage ? `: ${giteaMessage}` : ''),
        response.status,
      );
    }
    const data = text.length > 0 ? (JSON.parse(text) as T) : null;
    return { status: response.status, data };
  }

  async createBranch(options: CreateBranchOptions): Promise<{ branchName: string; sha: string }> {
    await this.request('POST', `/repos/${options.owner}/${options.repo}/branches`, {
      new_branch_name: options.branchName,
      old_ref_name: options.fromSha,
    });
    return { branchName: options.branchName, sha: options.fromSha };
  }

  async createPullRequest(
    options: CreatePullRequestOptions,
  ): Promise<{ prNumber: number; branchName: string }> {
    const { data } = await this.request<{ number: number }>(
      'POST',
      `/repos/${options.owner}/${options.repo}/pulls`,
      {
        head: options.branchName,
        base: options.baseBranch,
        title: options.title,
        body: options.body,
      },
    );
    return { prNumber: data!.number, branchName: options.branchName };
  }

  async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ObservedPullRequestState | null> {
    let pr: GiteaPullRequest;
    try {
      const res = await this.request<GiteaPullRequest>(
        'GET',
        `/repos/${owner}/${repo}/pulls/${prNumber}`,
      );
      pr = res.data!;
    } catch (err) {
      if (err instanceof GiteaApiError && err.status === 404) return null;
      throw err;
    }

    const [reviews, combinedStatus] = await Promise.all([
      this.paginateReviews(owner, repo, prNumber),
      this.request<GiteaCombinedStatus>(
        'GET',
        `/repos/${owner}/${repo}/commits/${pr.head.sha}/status`,
      ).then((r) => r.data ?? { state: 'pending', statuses: [] }),
    ]);

    return {
      prNumber: pr.number,
      branchName: pr.head.ref,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      state: pr.merged ? 'merged' : pr.state,
      reviewState: deriveReviewState(reviews),
      ciStatus: deriveCiStatus(combinedStatus),
      mergeable: pr.mergeable ?? null,
      blockingLabels: (pr.labels ?? []).map((l) => l.name ?? ''),
      // Documented lowest-common-denominator gap — see this module's header comment.
      conversationsResolved: false,
      mergedAt: pr.merged_at ?? null,
      mergeSha: pr.merge_commit_sha ?? null,
      closedAt: pr.closed_at ?? null,
    };
  }

  private async paginateReviews(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GiteaReview[]> {
    const all: GiteaReview[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { data } = await this.request<GiteaReview[]>(
        'GET',
        `/repos/${owner}/${repo}/pulls/${prNumber}/reviews?page=${page}&limit=${PAGE_SIZE}`,
      );
      const batch = data ?? [];
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return all;
  }

  async publishStatusCheck(options: PublishStatusCheckOptions): Promise<void> {
    await this.request('POST', `/repos/${options.owner}/${options.repo}/statuses/${options.sha}`, {
      state: options.state,
      target_url: options.targetUrl,
      description: options.description,
      context: options.context,
    });
  }

  async getRemainingRateLimit(): Promise<number> {
    // Gitea has no standard rate-limit-remaining endpoint — see this module's header comment.
    return RATE_LIMIT_SENTINEL;
  }

  async mergePullRequest(options: MergePullRequestOptions): Promise<{ mergeSha: string }> {
    try {
      await this.request(
        'POST',
        `/repos/${options.owner}/${options.repo}/pulls/${options.prNumber}/merge`,
        {
          Do: options.mergeMethod,
          MergeTitleField: options.commitTitle,
          MergeMessageField: options.commitMessage,
        },
      );
    } catch (err) {
      if (err instanceof GiteaApiError) {
        const message = err.message;
        // Gitea's merge endpoint has no expectedHeadSha-equivalent optimistic-concurrency
        // parameter, so this client can never observe a genuine sha-mismatch condition the way
        // OctokitGitHubClient's 409 handling does — see this module's header comment. Any rejected
        // merge (404/405/409/422, all observed as "this PR cannot be merged right now" in
        // practice) classifies as the non-auto-clearable reason.
        if (err.status === 404 || err.status === 405 || err.status === 409 || err.status === 422) {
          throw new ScmMergeRejectedError(
            `PR #${options.prNumber} is not mergeable: ${message}`,
            'not_mergeable',
            false,
          );
        }
      }
      // A genuine infrastructure/auth failure (401/403/5xx, or no HTTP status at all) is not a
      // merge-gate rejection — rethrow as-is, mirroring OctokitGitHubClient's identical contract.
      throw err;
    }

    const { data } = await this.request<GiteaPullRequest>(
      'GET',
      `/repos/${options.owner}/${options.repo}/pulls/${options.prNumber}`,
    );
    return { mergeSha: data?.merge_commit_sha ?? '' };
  }

  async getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/v1/repos/${owner}/${repo}/pulls/${prNumber}.diff`,
      {
        headers: { Authorization: `token ${this.token}` },
      },
    );
    if (!response.ok) {
      throw new GiteaApiError(
        `Gitea diff fetch for PR #${prNumber} failed with status ${response.status}`,
        response.status,
      );
    }
    return response.text();
  }

  async listPullRequestsForBranch(
    owner: string,
    repo: string,
    branchName: string,
    state: 'open' | 'closed' | 'all' = 'open',
  ): Promise<Array<{ prNumber: number; state: ScmPrState }>> {
    const matches: Array<{ prNumber: number; state: ScmPrState }> = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { data } = await this.request<GiteaPullRequest[]>(
        'GET',
        `/repos/${owner}/${repo}/pulls?state=${state}&page=${page}&limit=${PAGE_SIZE}`,
      );
      const batch = data ?? [];
      for (const pr of batch) {
        if (pr.head.ref === branchName) {
          matches.push({ prNumber: pr.number, state: pr.merged ? 'merged' : pr.state });
        }
      }
      if (batch.length < PAGE_SIZE) break;
    }
    return matches;
  }
}

/**
 * Gitea's PR review `state` values (`APPROVED`, `REQUEST_CHANGES`, `COMMENT`, `PENDING`,
 * `DISMISSED`) closely mirror GitHub's own — this mirrors `OctokitGitHubClient`'s
 * `deriveReviewState()` sticky-per-reviewer algorithm exactly (reduce to each reviewer's latest
 * review, but track a separate sticky "currently blocking" flag so a later COMMENT from a reviewer
 * who previously requested changes doesn't silently clear the block).
 */
export function deriveReviewState(reviews: GiteaReview[]): ObservedPullRequestState['reviewState'] {
  if (reviews.length === 0) return PrReviewState.NONE;

  const sorted = [...reviews].sort(
    (a, b) => new Date(a.submitted_at ?? 0).getTime() - new Date(b.submitted_at ?? 0).getTime(),
  );

  const latestByReviewer = new Map<string, GiteaReview>();
  const blockingByReviewer = new Map<string, boolean>();
  sorted.forEach((review, index) => {
    const key = review.user?.login ?? `__unknown_${index}`;
    latestByReviewer.set(key, review);
    if (review.state === 'REQUEST_CHANGES') {
      blockingByReviewer.set(key, true);
    } else if (review.state === 'APPROVED' || review.state === 'DISMISSED') {
      blockingByReviewer.set(key, false);
    }
  });
  const latestReviews = [...latestByReviewer.values()];
  const anyReviewerStillBlocking = [...blockingByReviewer.values()].some(Boolean);

  if (anyReviewerStillBlocking || latestReviews.some((r) => r.state === 'REQUEST_CHANGES')) {
    return PrReviewState.CHANGES_REQUESTED;
  }
  if (latestReviews.some((r) => r.state === 'APPROVED')) {
    return PrReviewState.APPROVED;
  }

  const last = sorted[sorted.length - 1];
  switch (last?.state) {
    case 'COMMENT':
      return PrReviewState.COMMENTED;
    case 'DISMISSED':
      return PrReviewState.DISMISSED;
    default:
      return PrReviewState.PENDING;
  }
}

/**
 * Gitea has no separate Checks-API concept — the combined commit-status endpoint's own aggregate
 * `state` field is the entire CI signal, so this is a direct mapping rather than
 * `OctokitGitHubClient`'s two-source merge.
 */
export function deriveCiStatus(
  combinedStatus: GiteaCombinedStatus,
): ObservedPullRequestState['ciStatus'] {
  switch (combinedStatus.state) {
    case 'success':
      return 'passed';
    case 'failure':
    case 'error':
      return 'failed';
    case 'pending':
      return 'pending';
    default:
      // Includes Gitea's 'warning' state, and any unrecognized value — treated as still-in-flight
      // rather than a false failure or false pass.
      return 'pending';
  }
}
