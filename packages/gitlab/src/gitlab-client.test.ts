import { describe, it, expect, vi } from 'vitest';
import { PrReviewState, ScmMergeRejectedError } from '@minicoder/core';
import {
  GitlabScmClient,
  deriveReviewState,
  deriveCiStatus,
  deriveConversationsResolved,
} from './gitlab-client.js';

interface FakeRoute {
  method: string;
  path: string;
  status?: number;
  body?: unknown;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

function fakeFetch(routes: FakeRoute[]): typeof fetch {
  return (async (input: unknown, init?: { method?: string }) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    // Prefer a route whose path consumes the URL's *entire* meaningful path (nothing but an
    // optional query string follows) over one that merely matches a leading prefix — e.g.
    // `/merge_requests/7` must not win against `/merge_requests/7/discussions` just because it's
    // a shorter string that happens to sort first; it must lose because more path follows it.
    const candidates = routes
      .filter((r) => r.method === method)
      .map((r) => {
        const index = url.indexOf(r.path);
        if (index === -1) return null;
        const suffix = url.slice(index + r.path.length);
        const isFullMatch = suffix === '' || suffix.startsWith('?');
        return { route: r, isFullMatch, pathLength: r.path.length };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const match = candidates.sort((a, b) => {
      if (a.isFullMatch !== b.isFullMatch) return a.isFullMatch ? -1 : 1;
      return b.pathLength - a.pathLength;
    })[0]?.route;
    if (!match) {
      throw new Error(`fakeFetch: no route registered for ${method} ${url}`);
    }
    return jsonResponse(match.status ?? 200, match.body);
  }) as typeof fetch;
}

const BASE = { baseUrl: 'https://gitlab.example.test', token: 'tok' };

describe('GitlabScmClient', () => {
  it('createBranch echoes the requested branch name and fromSha', async () => {
    const client = new GitlabScmClient({
      ...BASE,
      fetchImpl: fakeFetch([{ method: 'POST', path: '/repository/branches', body: {} }]),
    });
    const result = await client.createBranch({
      owner: 'o',
      repo: 'r',
      branchName: 'minicoder/fr-1',
      fromSha: 'abc123',
    });
    expect(result).toEqual({ branchName: 'minicoder/fr-1', sha: 'abc123' });
  });

  it('createPullRequest returns the MR iid as prNumber', async () => {
    const client = new GitlabScmClient({
      ...BASE,
      fetchImpl: fakeFetch([{ method: 'POST', path: '/merge_requests', body: { iid: 42 } }]),
    });
    const result = await client.createPullRequest({
      owner: 'o',
      repo: 'r',
      branchName: 'minicoder/fr-1',
      baseBranch: 'main',
      title: 'Add widget',
    });
    expect(result).toEqual({ prNumber: 42, branchName: 'minicoder/fr-1' });
  });

  it('getPullRequest returns null on a 404', async () => {
    const client = new GitlabScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        { method: 'GET', path: '/merge_requests/7', status: 404, body: { message: 'not found' } },
      ]),
    });
    expect(await client.getPullRequest('o', 'r', 7)).toBeNull();
  });

  it('getPullRequest assembles ObservedPullRequestState from the MR, approvals, discussions, and pipelines', async () => {
    const client = new GitlabScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        {
          method: 'GET',
          path: '/merge_requests/7',
          body: {
            iid: 7,
            state: 'opened',
            merged_at: null,
            merge_commit_sha: null,
            closed_at: null,
            sha: 'headsha',
            source_branch: 'minicoder/fr-1',
            target_branch: 'main',
            labels: ['wip'],
            merge_status: 'can_be_merged',
          },
        },
        { method: 'GET', path: '/approvals', body: { approvals_required: 1, approvals_left: 0 } },
        { method: 'GET', path: '/discussions', body: [] },
        { method: 'GET', path: '/pipelines', body: [{ status: 'success', sha: 'headsha' }] },
      ]),
    });

    const observed = await client.getPullRequest('o', 'r', 7);
    expect(observed).toEqual({
      prNumber: 7,
      branchName: 'minicoder/fr-1',
      baseBranch: 'main',
      headSha: 'headsha',
      state: 'open',
      reviewState: PrReviewState.APPROVED,
      ciStatus: 'passed',
      mergeable: true,
      blockingLabels: ['wip'],
      conversationsResolved: true,
      mergedAt: null,
      mergeSha: null,
      closedAt: null,
    });
  });

  it('publishStatusCheck posts to the statuses endpoint, mapping "error" to "failed"', async () => {
    const fetchImpl = vi.fn(fakeFetch([{ method: 'POST', path: '/statuses/headsha', body: {} }]));
    const client = new GitlabScmClient({ ...BASE, fetchImpl });
    await client.publishStatusCheck({
      owner: 'o',
      repo: 'r',
      sha: 'headsha',
      context: 'minicoder/review-gate',
      state: 'error',
    });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toMatchObject({
      state: 'failed',
      name: 'minicoder/review-gate',
    });
  });

  it('getRemainingRateLimit returns a large sentinel', async () => {
    const client = new GitlabScmClient({ ...BASE, fetchImpl: fakeFetch([]) });
    expect(await client.getRemainingRateLimit()).toBeGreaterThan(1_000_000);
  });

  it('mergePullRequest passes sha and squash, returning the merge commit sha', async () => {
    const fetchImpl = vi.fn(
      fakeFetch([
        { method: 'PUT', path: '/merge_requests/7/merge', body: { merge_commit_sha: 'mergedsha' } },
      ]),
    );
    const client = new GitlabScmClient({ ...BASE, fetchImpl });
    const result = await client.mergePullRequest({
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      mergeMethod: 'squash',
      expectedHeadSha: 'headsha',
    });
    expect(result).toEqual({ mergeSha: 'mergedsha' });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toMatchObject({ squash: true, sha: 'headsha' });
  });

  it('mergePullRequest rebases first when mergeMethod is rebase, then merges without squash', async () => {
    const fetchImpl = vi.fn(
      fakeFetch([
        { method: 'PUT', path: '/merge_requests/7/rebase', body: {} },
        { method: 'GET', path: '/merge_requests/7', body: { rebase_in_progress: false } },
        { method: 'PUT', path: '/merge_requests/7/merge', body: { merge_commit_sha: 'mergedsha' } },
      ]),
    );
    const client = new GitlabScmClient({ ...BASE, fetchImpl });
    const result = await client.mergePullRequest({
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      mergeMethod: 'rebase',
    });
    expect(result).toEqual({ mergeSha: 'mergedsha' });
    const rebaseCall = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('/rebase'));
    expect(rebaseCall).toBeDefined();
    const mergeCall = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('/merge'));
    expect(JSON.parse((mergeCall![1] as { body: string }).body)).toMatchObject({ squash: false });
  });

  it('mergePullRequest classifies a 406 as sha_mismatch/autoClearable', async () => {
    const client = new GitlabScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        {
          method: 'PUT',
          path: '/merge_requests/7/merge',
          status: 406,
          body: { message: 'sha mismatch' },
        },
      ]),
    });
    await expect(
      client.mergePullRequest({
        owner: 'o',
        repo: 'r',
        prNumber: 7,
        mergeMethod: 'merge',
        expectedHeadSha: 'stale',
      }),
    ).rejects.toMatchObject({ reason: 'sha_mismatch', autoClearable: true });
  });

  it('mergePullRequest classifies a 405 as not_mergeable/not autoClearable', async () => {
    const client = new GitlabScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        {
          method: 'PUT',
          path: '/merge_requests/7/merge',
          status: 405,
          body: { message: 'not mergeable' },
        },
      ]),
    });
    await expect(
      client.mergePullRequest({ owner: 'o', repo: 'r', prNumber: 7, mergeMethod: 'merge' }),
    ).rejects.toMatchObject({ reason: 'not_mergeable', autoClearable: false });
  });

  it('mergePullRequest rethrows a genuine infrastructure failure untouched', async () => {
    const client = new GitlabScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        {
          method: 'PUT',
          path: '/merge_requests/7/merge',
          status: 401,
          body: { message: 'bad token' },
        },
      ]),
    });
    await expect(
      client.mergePullRequest({ owner: 'o', repo: 'r', prNumber: 7, mergeMethod: 'merge' }),
    ).rejects.not.toBeInstanceOf(ScmMergeRejectedError);
  });

  it("getPullRequestDiff synthesizes a unified-diff-like text from GitLab's per-file diff entries", async () => {
    const client = new GitlabScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        {
          method: 'GET',
          path: '/diffs',
          body: [{ old_path: 'a.txt', new_path: 'a.txt', diff: '@@ -1 +1 @@\n-old\n+new\n' }],
        },
      ]),
    });
    const diff = await client.getPullRequestDiff('o', 'r', 7);
    expect(diff).toContain('diff --git a/a.txt b/a.txt');
    expect(diff).toContain('+new');
  });

  it("listPullRequestsForBranch relies on GitLab's server-side source_branch filter (no client-side filtering)", async () => {
    const client = new GitlabScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        {
          method: 'GET',
          path: '/merge_requests?source_branch=minicoder%2Ffr-1',
          body: [{ iid: 2, state: 'opened' }],
        },
      ]),
    });
    const result = await client.listPullRequestsForBranch('o', 'r', 'minicoder/fr-1');
    expect(result).toEqual([{ prNumber: 2, state: 'open' }]);
  });
});

describe('deriveConversationsResolved', () => {
  it('is true when there are no discussions', () => {
    expect(deriveConversationsResolved([])).toBe(true);
  });

  it('is false when a resolvable discussion is unresolved', () => {
    expect(deriveConversationsResolved([{ notes: [{ resolvable: true, resolved: false }] }])).toBe(
      false,
    );
  });

  it('is true when every resolvable discussion is resolved', () => {
    expect(deriveConversationsResolved([{ notes: [{ resolvable: true, resolved: true }] }])).toBe(
      true,
    );
  });

  it('ignores non-resolvable notes (plain comments)', () => {
    expect(deriveConversationsResolved([{ notes: [{ resolvable: false, resolved: false }] }])).toBe(
      true,
    );
  });
});

describe('deriveReviewState (the documented lowest-common-denominator synthesis)', () => {
  it('returns NONE with no approvals and no discussions', () => {
    expect(deriveReviewState({ approvals_required: 0, approvals_left: 0 }, [])).toBe(
      PrReviewState.NONE,
    );
  });

  it('returns APPROVED when approvals_left is 0 and no unresolved discussions', () => {
    expect(deriveReviewState({ approvals_required: 1, approvals_left: 0 }, [])).toBe(
      PrReviewState.APPROVED,
    );
  });

  it('returns PENDING when approvals are still outstanding and no discussions', () => {
    expect(deriveReviewState({ approvals_required: 2, approvals_left: 1 }, [])).toBe(
      PrReviewState.PENDING,
    );
  });

  it('returns CHANGES_REQUESTED — synthesized from an unresolved discussion — even with zero approvals_left', () => {
    // This is the core Stage 4 acceptance scenario: GitLab reports full approval, but an
    // unresolved review thread still exists. There is no GitLab webhook for this condition at
    // all (see normalize.ts) — only a fresh getPullRequest() observation (i.e. reconciliation)
    // can ever discover it.
    const state = deriveReviewState({ approvals_required: 1, approvals_left: 0 }, [
      { notes: [{ resolvable: true, resolved: false }] },
    ]);
    expect(state).toBe(PrReviewState.CHANGES_REQUESTED);
  });
});

describe('deriveCiStatus', () => {
  it('returns pending when there are no pipelines yet', () => {
    expect(deriveCiStatus([])).toBe('pending');
  });

  it.each([
    ['success', 'passed'],
    ['failed', 'failed'],
    ['running', 'running'],
    ['canceled', 'pending'],
    ['skipped', 'pending'],
    ['manual', 'pending'],
  ] as const)('maps pipeline status %s to %s', (status, expected) => {
    expect(deriveCiStatus([{ status }])).toBe(expected);
  });

  it('uses the first (most recent) pipeline when multiple exist', () => {
    expect(deriveCiStatus([{ status: 'success' }, { status: 'failed' }])).toBe('passed');
  });
});
