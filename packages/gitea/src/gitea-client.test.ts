import { describe, it, expect, vi } from 'vitest';
import { PrReviewState, ScmMergeRejectedError } from '@minicoder/core';
import { GiteaScmClient, deriveReviewState, deriveCiStatus } from './gitea-client.js';

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
    // `/pulls/7` must not win against `/pulls/7/reviews` just because "longest path wins" would
    // otherwise pick whichever string happens to be longer (a real bug this exact shape hit in
    // @minicoder/gitlab's equivalent test, caught and fixed there first).
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
    if (match.path.endsWith('.diff')) {
      return {
        ok: (match.status ?? 200) < 300,
        status: match.status ?? 200,
        text: async () => (match.body as string) ?? '',
      } as Response;
    }
    return jsonResponse(match.status ?? 200, match.body);
  }) as typeof fetch;
}

const BASE = { baseUrl: 'https://gitea.example.test', token: 'tok' };

describe('GiteaScmClient', () => {
  it('createBranch echoes the requested branch name and fromSha', async () => {
    const client = new GiteaScmClient({
      ...BASE,
      fetchImpl: fakeFetch([{ method: 'POST', path: '/branches', body: {} }]),
    });
    const result = await client.createBranch({
      owner: 'o',
      repo: 'r',
      branchName: 'minicoder/fr-1',
      fromSha: 'abc123',
    });
    expect(result).toEqual({ branchName: 'minicoder/fr-1', sha: 'abc123' });
  });

  it('createPullRequest returns the PR number from the response', async () => {
    const client = new GiteaScmClient({
      ...BASE,
      fetchImpl: fakeFetch([{ method: 'POST', path: '/pulls', body: { number: 42 } }]),
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
    const client = new GiteaScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        { method: 'GET', path: '/pulls/7', status: 404, body: { message: 'not found' } },
      ]),
    });
    const result = await client.getPullRequest('o', 'r', 7);
    expect(result).toBeNull();
  });

  it('getPullRequest assembles ObservedPullRequestState from the PR, reviews, and combined status', async () => {
    const client = new GiteaScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        {
          method: 'GET',
          path: '/pulls/7',
          body: {
            number: 7,
            state: 'open',
            merged: false,
            merged_at: null,
            merge_commit_sha: null,
            closed_at: null,
            mergeable: true,
            head: { ref: 'minicoder/fr-1', sha: 'headsha' },
            base: { ref: 'main' },
            labels: [{ name: 'wip' }],
          },
        },
        {
          method: 'GET',
          path: '/pulls/7/reviews',
          body: [
            { state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z', user: { login: 'alice' } },
          ],
        },
        {
          method: 'GET',
          path: '/commits/headsha/status',
          body: { state: 'success', statuses: [] },
        },
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
      conversationsResolved: false,
      mergedAt: null,
      mergeSha: null,
      closedAt: null,
    });
  });

  it('publishStatusCheck posts to the statuses endpoint', async () => {
    const fetchImpl = vi.fn(fakeFetch([{ method: 'POST', path: '/statuses/headsha', body: {} }]));
    const client = new GiteaScmClient({ ...BASE, fetchImpl });
    await client.publishStatusCheck({
      owner: 'o',
      repo: 'r',
      sha: 'headsha',
      context: 'minicoder/review-gate',
      state: 'success',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain('/statuses/headsha');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      state: 'success',
      context: 'minicoder/review-gate',
    });
  });

  it('getRemainingRateLimit returns a large sentinel (Gitea has no rate-limit endpoint)', async () => {
    const client = new GiteaScmClient({ ...BASE, fetchImpl: fakeFetch([]) });
    const remaining = await client.getRemainingRateLimit();
    expect(remaining).toBeGreaterThan(1_000_000);
  });

  it('mergePullRequest posts Do=<mergeMethod> and re-fetches the merge commit sha', async () => {
    const client = new GiteaScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        { method: 'POST', path: '/pulls/7/merge', body: {} },
        {
          method: 'GET',
          path: '/pulls/7',
          body: { number: 7, merge_commit_sha: 'mergedsha' },
        },
      ]),
    });
    const result = await client.mergePullRequest({
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      mergeMethod: 'squash',
    });
    expect(result).toEqual({ mergeSha: 'mergedsha' });
  });

  it('mergePullRequest classifies a rejected merge as not_mergeable, never sha_mismatch', async () => {
    const client = new GiteaScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        { method: 'POST', path: '/pulls/7/merge', status: 405, body: { message: 'not mergeable' } },
      ]),
    });
    await expect(
      client.mergePullRequest({ owner: 'o', repo: 'r', prNumber: 7, mergeMethod: 'merge' }),
    ).rejects.toMatchObject({
      reason: 'not_mergeable',
      autoClearable: false,
    });
  });

  it('mergePullRequest rethrows a genuine infrastructure failure untouched', async () => {
    const client = new GiteaScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        {
          method: 'POST',
          path: '/pulls/7/merge',
          status: 401,
          body: { message: 'bad credentials' },
        },
      ]),
    });
    await expect(
      client.mergePullRequest({ owner: 'o', repo: 'r', prNumber: 7, mergeMethod: 'merge' }),
    ).rejects.not.toBeInstanceOf(ScmMergeRejectedError);
  });

  it('getPullRequestDiff returns the raw diff text', async () => {
    const client = new GiteaScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        { method: 'GET', path: '/pulls/7.diff', body: 'diff --git a/x b/x\n' },
      ]),
    });
    const diff = await client.getPullRequestDiff('o', 'r', 7);
    expect(diff).toBe('diff --git a/x b/x\n');
  });

  it('listPullRequestsForBranch filters client-side by head ref', async () => {
    const client = new GiteaScmClient({
      ...BASE,
      fetchImpl: fakeFetch([
        {
          method: 'GET',
          path: '/pulls?state=open',
          body: [
            { number: 1, state: 'open', merged: false, head: { ref: 'other-branch' } },
            { number: 2, state: 'open', merged: false, head: { ref: 'minicoder/fr-1' } },
          ],
        },
      ]),
    });
    const result = await client.listPullRequestsForBranch('o', 'r', 'minicoder/fr-1');
    expect(result).toEqual([{ prNumber: 2, state: 'open' }]);
  });
});

describe('deriveReviewState', () => {
  it('returns NONE for no reviews', () => {
    expect(deriveReviewState([])).toBe(PrReviewState.NONE);
  });

  it('a later COMMENT from a reviewer who requested changes does not clear the block', () => {
    const state = deriveReviewState([
      { state: 'REQUEST_CHANGES', submitted_at: '2026-01-01T00:00:00Z', user: { login: 'bob' } },
      { state: 'COMMENT', submitted_at: '2026-01-02T00:00:00Z', user: { login: 'bob' } },
    ]);
    expect(state).toBe(PrReviewState.CHANGES_REQUESTED);
  });

  it("an approval from one reviewer does not clear another reviewer's outstanding REQUEST_CHANGES", () => {
    const state = deriveReviewState([
      { state: 'REQUEST_CHANGES', submitted_at: '2026-01-01T00:00:00Z', user: { login: 'alice' } },
      { state: 'APPROVED', submitted_at: '2026-01-02T00:00:00Z', user: { login: 'bob' } },
    ]);
    expect(state).toBe(PrReviewState.CHANGES_REQUESTED);
  });
});

describe('deriveCiStatus', () => {
  it.each([
    ['success', 'passed'],
    ['failure', 'failed'],
    ['error', 'failed'],
    ['pending', 'pending'],
    ['warning', 'pending'],
  ] as const)('maps combined-status state %s to %s', (state, expected) => {
    expect(deriveCiStatus({ state })).toBe(expected);
  });
});
