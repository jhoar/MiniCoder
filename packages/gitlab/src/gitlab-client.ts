/**
 * GitlabScmClient — the GitLab-backed implementation of the `ScmClient` seam defined in
 * `packages/core/src/scm/client.ts` (docs/06 §Phase 18 Stage 4 — "largest lowest-common-
 * denominator compromise"). Core stays provider-SDK-free; this file (and `packages/gitlab`
 * generally) is the only place GitLab's REST API v4 is spoken.
 *
 * No vendor SDK: a hand-rolled `fetch`-based client (the injectable-`fetchImpl` seam already
 * established by `HttpCodeGenerationProvider`/`GiteaScmClient`/etc.), authenticating via GitLab's
 * `PRIVATE-TOKEN` header (a personal or project access token — there is no GitLab equivalent of a
 * GitHub App). Self-hosted, so `baseUrl` is required, exactly like `GiteaScmClient`.
 *
 * Projects are addressed by URL-encoded `owner/repo` path (`encodeURIComponent('owner/repo')`),
 * GitLab's documented alternative to a numeric project ID. GitLab's per-project MR number is
 * called `iid` (internal ID) — this is what `prNumber` maps to throughout this file; GitLab also
 * has a global `id` per MR that this client never uses.
 *
 * **Verification status (same honest-labeling posture as `packages/gitea`):** based on GitLab's
 * documented REST API v4 and webhook payload shapes, reviewed for correctness, not exercised
 * against a live GitLab instance in this repository's CI — see `infra/docker-compose.gitlab.yml`'s
 * own header comment for why. Unit tests exercise this client against a fake `fetchImpl`.
 *
 * **This is the largest lowest-common-denominator compromise of the three providers, documented
 * here rather than silently absorbed (per docs/06 §Phase 18's own framing):**
 *
 *   - **`reviewState` is synthesized, not observed** (see `deriveReviewState()` below) — GitLab has
 *     no discrete "changes requested" review state at all. This is the one place this client's
 *     fidelity is genuinely lower than Gitea's (which mirrors GitHub's review model closely).
 *   - **`conversationsResolved` is a real observation, not a placeholder** — unusually, GitLab's
 *     discussions API is *better* native support for this than Gitea's (which has no such field at
 *     all) and comparable to GitHub's GraphQL-only support. Not every field on this client is a
 *     downgrade from GitHub.
 *   - **`mergePullRequest()`'s `mergeMethod: 'rebase'` is a two-step, best-effort approximation.**
 *     GitLab's merge endpoint has no per-call "rebase" strategy parameter (only `squash: boolean`)
 *     — the underlying merge commit vs. fast-forward strategy is a *project-level* setting, not a
 *     per-request choice. A `'rebase'` request therefore calls GitLab's separate asynchronous
 *     `/rebase` endpoint first, polls briefly for completion, then merges without squash — this is
 *     not atomic the way a single GitHub/Gitea merge call is, and a rebase that doesn't finish
 *     within the bounded poll window falls through to a merge attempt against whatever state the
 *     branch is actually in (which GitLab's own `sha`/mergeability checks then correctly reject if
 *     it isn't ready). `mergeMethod: 'merge'`/`'squash'` map directly and atomically.
 *   - **GitLab's merge `sha` parameter genuinely supports the same optimistic-concurrency guard
 *     GitHub's `sha` does** — unlike Gitea, which has no such parameter at all. This is the one
 *     place GitLab's fidelity matches GitHub's exactly.
 *   - **`getPullRequestDiff()` returns a synthesized unified-diff-like text, not GitLab's native
 *     format.** GitLab's diffs endpoint returns structured per-file diff objects, not a single
 *     unified-diff blob the way GitHub's/Gitea's `.diff` media type does — this client concatenates
 *     each file's hunk under a synthetic `diff --git a/... b/...` header. Close enough for an LLM
 *     reviewer to consume (the actual real consumer, per the Reviewer adapter), not byte-identical
 *     to real `git diff` output.
 *   - **`getRemainingRateLimit()` returns a large sentinel**, the same simplification as
 *     `GiteaScmClient` — GitLab.com and some self-managed instances expose `RateLimit-Remaining`
 *     response headers, but this is not guaranteed across every self-hosted configuration, and (as
 *     Stage 3 found) this method has no real production caller to justify the added statefulness
 *     of tracking per-response headers across calls.
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

export interface GitlabScmClientOptions {
  /** The GitLab instance's base URL, e.g. `https://gitlab.example.com` (no trailing slash needed). */
  baseUrl: string;
  /** A GitLab personal or project access token. */
  token: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** A non-2xx GitLab API response, carrying the HTTP status for caller-side classification. */
export class GitlabApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'GitlabApiError';
  }
}

const RATE_LIMIT_SENTINEL = Number.MAX_SAFE_INTEGER;
const MAX_PAGES = 20;
const PER_PAGE = 50;
/** Bounded poll for the asynchronous rebase-before-merge path — see this module's header comment. */
const REBASE_POLL_ATTEMPTS = 5;
const REBASE_POLL_DELAY_MS = 500;

interface GitlabMergeRequest {
  iid: number;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  merged_at: string | null;
  merge_commit_sha: string | null;
  closed_at: string | null;
  sha: string | null;
  source_branch: string;
  target_branch: string;
  labels?: string[];
  merge_status?: string;
  rebase_in_progress?: boolean;
  merge_error?: string | null;
}

interface GitlabApprovals {
  approvals_required?: number;
  approvals_left?: number;
}

interface GitlabDiscussionNote {
  resolvable?: boolean;
  resolved?: boolean;
}

interface GitlabDiscussion {
  notes?: GitlabDiscussionNote[];
}

interface GitlabPipeline {
  status: string;
  sha?: string;
}

interface GitlabDiffEntry {
  old_path: string;
  new_path: string;
  diff: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
}

function encodeProjectId(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

/** GitLab's MR state is `opened`/`closed`/`merged`/`locked` — `locked` (mid-merge) maps to `open`. */
function mapGitlabState(state: GitlabMergeRequest['state']): ScmPrState {
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'closed';
  return 'open';
}

export class GitlabScmClient implements ScmClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitlabScmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T | null }> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v4${path}`, {
      method,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return { status: response.status, data: null };
    const text = await response.text();
    const data = text.length > 0 ? (JSON.parse(text) as T) : null;
    if (!response.ok) {
      throw new GitlabApiError(
        `GitLab API ${method} ${path} failed with status ${response.status}`,
        response.status,
      );
    }
    return { status: response.status, data };
  }

  async createBranch(options: CreateBranchOptions): Promise<{ branchName: string; sha: string }> {
    const projectId = encodeProjectId(options.owner, options.repo);
    await this.request('POST', `/projects/${projectId}/repository/branches`, {
      branch: options.branchName,
      ref: options.fromSha,
    });
    return { branchName: options.branchName, sha: options.fromSha };
  }

  async createPullRequest(
    options: CreatePullRequestOptions,
  ): Promise<{ prNumber: number; branchName: string }> {
    const projectId = encodeProjectId(options.owner, options.repo);
    const { data } = await this.request<{ iid: number }>(
      'POST',
      `/projects/${projectId}/merge_requests`,
      {
        source_branch: options.branchName,
        target_branch: options.baseBranch,
        title: options.title,
        description: options.body,
      },
    );
    return { prNumber: data!.iid, branchName: options.branchName };
  }

  async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ObservedPullRequestState | null> {
    const projectId = encodeProjectId(owner, repo);
    let mr: GitlabMergeRequest;
    try {
      const res = await this.request<GitlabMergeRequest>(
        'GET',
        `/projects/${projectId}/merge_requests/${prNumber}`,
      );
      mr = res.data!;
    } catch (err) {
      if (err instanceof GitlabApiError && err.status === 404) return null;
      throw err;
    }

    const [approvals, discussions, pipelines] = await Promise.all([
      this.request<GitlabApprovals>(
        'GET',
        `/projects/${projectId}/merge_requests/${prNumber}/approvals`,
      ).then((r) => r.data ?? {}),
      this.paginateDiscussions(projectId, prNumber),
      this.request<GitlabPipeline[]>(
        'GET',
        `/projects/${projectId}/merge_requests/${prNumber}/pipelines`,
      ).then((r) => r.data ?? []),
    ]);

    return {
      prNumber: mr.iid,
      branchName: mr.source_branch,
      baseBranch: mr.target_branch,
      headSha: mr.sha,
      state: mapGitlabState(mr.state),
      reviewState: deriveReviewState(approvals, discussions),
      ciStatus: deriveCiStatus(pipelines),
      mergeable: mr.merge_status ? mr.merge_status === 'can_be_merged' : null,
      blockingLabels: mr.labels ?? [],
      conversationsResolved: deriveConversationsResolved(discussions),
      mergedAt: mr.merged_at ?? null,
      mergeSha: mr.merge_commit_sha ?? null,
      closedAt: mr.closed_at ?? null,
    };
  }

  private async paginateDiscussions(
    projectId: string,
    prNumber: number,
  ): Promise<GitlabDiscussion[]> {
    const all: GitlabDiscussion[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { data } = await this.request<GitlabDiscussion[]>(
        'GET',
        `/projects/${projectId}/merge_requests/${prNumber}/discussions?page=${page}&per_page=${PER_PAGE}`,
      );
      const batch = data ?? [];
      all.push(...batch);
      if (batch.length < PER_PAGE) break;
    }
    return all;
  }

  async publishStatusCheck(options: PublishStatusCheckOptions): Promise<void> {
    const projectId = encodeProjectId(options.owner, options.repo);
    const state = options.state === 'error' ? 'failed' : options.state;
    await this.request('POST', `/projects/${projectId}/statuses/${options.sha}`, {
      state,
      name: options.context,
      target_url: options.targetUrl,
      description: options.description,
    });
  }

  async getRemainingRateLimit(): Promise<number> {
    // GitLab has no rate-limit endpoint guaranteed across every self-hosted config — see this
    // module's header comment.
    return RATE_LIMIT_SENTINEL;
  }

  private async rebaseAndWait(projectId: string, prNumber: number): Promise<void> {
    await this.request('PUT', `/projects/${projectId}/merge_requests/${prNumber}/rebase`);
    for (let attempt = 0; attempt < REBASE_POLL_ATTEMPTS; attempt += 1) {
      const { data } = await this.request<GitlabMergeRequest>(
        'GET',
        `/projects/${projectId}/merge_requests/${prNumber}`,
      );
      if (data && !data.rebase_in_progress) return;
      await new Promise((resolve) => setTimeout(resolve, REBASE_POLL_DELAY_MS));
    }
    // Bounded wait exhausted — fall through to the merge attempt anyway; GitLab's own mergeability
    // checks on the merge call itself correctly reject a branch that isn't actually ready.
  }

  async mergePullRequest(options: MergePullRequestOptions): Promise<{ mergeSha: string }> {
    const projectId = encodeProjectId(options.owner, options.repo);

    if (options.mergeMethod === 'rebase') {
      await this.rebaseAndWait(projectId, options.prNumber);
    }

    try {
      const { data } = await this.request<GitlabMergeRequest>(
        'PUT',
        `/projects/${projectId}/merge_requests/${options.prNumber}/merge`,
        {
          squash: options.mergeMethod === 'squash',
          merge_commit_message: options.commitMessage,
          squash_commit_message:
            options.mergeMethod === 'squash' ? options.commitMessage : undefined,
          sha: options.expectedHeadSha,
        },
      );
      return { mergeSha: data?.merge_commit_sha ?? '' };
    } catch (err) {
      if (err instanceof GitlabApiError) {
        const message = err.message;
        // GitLab's merge endpoint genuinely supports the same sha-mismatch guard GitHub's does
        // (unlike Gitea's, which has none): 406 is GitLab's documented response when the supplied
        // `sha` no longer matches the MR's real head. 405 covers "not mergeable" (conflicts, a
        // required pipeline hasn't succeeded, branch protection). Both only apply when we actually
        // requested a merge — the classification is only reachable from this call site.
        if (err.status === 406) {
          throw new ScmMergeRejectedError(
            `MR !${options.prNumber} head moved since the merge gate was evaluated: ${message}`,
            'sha_mismatch',
            true,
          );
        }
        if (err.status === 405) {
          throw new ScmMergeRejectedError(
            `MR !${options.prNumber} is not mergeable: ${message}`,
            'not_mergeable',
            false,
          );
        }
      }
      throw err;
    }
  }

  async getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    const projectId = encodeProjectId(owner, repo);
    const entries: GitlabDiffEntry[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { data } = await this.request<GitlabDiffEntry[]>(
        'GET',
        `/projects/${projectId}/merge_requests/${prNumber}/diffs?page=${page}&per_page=${PER_PAGE}`,
      );
      const batch = data ?? [];
      entries.push(...batch);
      if (batch.length < PER_PAGE) break;
    }
    // Synthesized unified-diff-like text — see this module's header comment.
    return entries
      .map((entry) => `diff --git a/${entry.old_path} b/${entry.new_path}\n${entry.diff}`)
      .join('\n');
  }

  async listPullRequestsForBranch(
    owner: string,
    repo: string,
    branchName: string,
    state: 'open' | 'closed' | 'all' = 'open',
  ): Promise<Array<{ prNumber: number; state: ScmPrState }>> {
    const projectId = encodeProjectId(owner, repo);
    const gitlabState = state === 'open' ? 'opened' : state === 'closed' ? 'closed' : 'all';
    const matches: Array<{ prNumber: number; state: ScmPrState }> = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      // GitLab's list-MRs endpoint natively supports source_branch filtering — unlike Gitea's,
      // this needs no client-side filtering.
      const { data } = await this.request<GitlabMergeRequest[]>(
        'GET',
        `/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(branchName)}&state=${gitlabState}&page=${page}&per_page=${PER_PAGE}`,
      );
      const batch = data ?? [];
      for (const mr of batch) {
        matches.push({
          prNumber: mr.iid,
          state: mapGitlabState(mr.state),
        });
      }
      if (batch.length < PER_PAGE) break;
    }
    return matches;
  }
}

function hasUnresolvedDiscussion(discussions: GitlabDiscussion[]): boolean {
  return discussions.some((d) => (d.notes ?? []).some((n) => n.resolvable && !n.resolved));
}

/** A real observation — GitLab's discussions API natively supports this, unlike Gitea's. */
export function deriveConversationsResolved(discussions: GitlabDiscussion[]): boolean {
  return !hasUnresolvedDiscussion(discussions);
}

/**
 * GitLab has no discrete "changes requested" review state — this synthesizes one from approval
 * count plus unresolved (resolvable) discussions, per this module's header comment. An unresolved
 * discussion is treated as blocking regardless of approval count: a reviewer left feedback that
 * hasn't been addressed, which should block even if enough people approved before the discussion
 * was opened. This is the single largest fidelity reduction versus GitHub/Gitea's real
 * per-reviewer review-state observation.
 */
export function deriveReviewState(
  approvals: GitlabApprovals,
  discussions: GitlabDiscussion[],
): ObservedPullRequestState['reviewState'] {
  if (hasUnresolvedDiscussion(discussions)) {
    return PrReviewState.CHANGES_REQUESTED;
  }
  const approvalsLeft = approvals.approvals_left ?? 0;
  const approvalsRequired = approvals.approvals_required ?? 0;
  if (approvalsRequired === 0 && approvalsLeft === 0 && discussions.length === 0) {
    return PrReviewState.NONE;
  }
  if (approvalsLeft === 0) {
    return PrReviewState.APPROVED;
  }
  return PrReviewState.PENDING;
}

/**
 * GitLab's pipeline `status` is the entire CI signal for an MR (no separate Checks-API concept),
 * the same simplification `GiteaScmClient.deriveCiStatus()` documents. Ambiguous/non-terminal
 * states (`canceled`, `skipped`, `manual`, `created`, `preparing`, `scheduled`,
 * `waiting_for_resource`) are treated as still-in-flight rather than a false failure or false pass.
 */
export function deriveCiStatus(pipelines: GitlabPipeline[]): ObservedPullRequestState['ciStatus'] {
  const latest = pipelines[0];
  if (!latest) return 'pending';
  switch (latest.status) {
    case 'success':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    default:
      return 'pending';
  }
}
