import { describe, it, expect, vi, afterEach } from 'vitest';
import { deriveCiStatus, deriveReviewState } from './octokit-client.js';
import { GithubMergeRejectedError, PrReviewState } from '@minicoder/core';

/**
 * HIGH-4 code-review fix: OctokitGitHubClient.getPullRequest() combines GitHub Checks
 * (checkRuns) with the legacy combined commit-status API (repos.getCombinedStatusForRef) so CI
 * status is derived correctly for repos that only publish legacy `status` events (no Checks API
 * usage at all), matching docs' declared support for the `status` webhook event. Precedence:
 * failure from either source wins outright; else pending/in-progress from either wins next; else
 * success from at least one (with neither failure nor pending) is 'passed'; else 'pending'.
 */
describe('deriveCiStatus (Checks API + combined commit-status combine algorithm)', () => {
  it('returns pending when neither source has any signal', () => {
    expect(deriveCiStatus([], { state: 'pending', total_count: 0 })).toBe('pending');
  });

  it('returns passed from Checks API alone when there is no commit-status signal', () => {
    expect(
      deriveCiStatus([{ status: 'completed', conclusion: 'success' }], {
        state: 'pending',
        total_count: 0,
      }),
    ).toBe('passed');
  });

  it('returns passed from the legacy commit-status API alone (no Checks API usage)', () => {
    expect(deriveCiStatus([], { state: 'success', total_count: 1 })).toBe('passed');
  });

  it('returns failed from the legacy commit-status API alone', () => {
    expect(deriveCiStatus([], { state: 'failure', total_count: 1 })).toBe('failed');
  });

  it('treats a legacy commit-status "error" state as failed', () => {
    expect(deriveCiStatus([], { state: 'error', total_count: 1 })).toBe('failed');
  });

  it('failure from Checks API wins even when the commit status is pending', () => {
    expect(
      deriveCiStatus([{ status: 'completed', conclusion: 'failure' }], {
        state: 'pending',
        total_count: 1,
      }),
    ).toBe('failed');
  });

  it('failure from the commit-status API wins even when all check runs passed', () => {
    expect(
      deriveCiStatus([{ status: 'completed', conclusion: 'success' }], {
        state: 'failure',
        total_count: 1,
      }),
    ).toBe('failed');
  });

  it('pending/in-progress from either source wins over a passed signal from the other, absent any failure', () => {
    expect(
      deriveCiStatus([{ status: 'completed', conclusion: 'success' }], {
        state: 'pending',
        total_count: 1,
      }),
    ).toBe('running');
    expect(
      deriveCiStatus([{ status: 'in_progress', conclusion: null }], {
        state: 'success',
        total_count: 1,
      }),
    ).toBe('running');
  });

  it('passes only when at least one source succeeds and neither has failure/pending', () => {
    expect(
      deriveCiStatus([{ status: 'completed', conclusion: 'success' }], {
        state: 'success',
        total_count: 1,
      }),
    ).toBe('passed');
  });
});

/**
 * HIGH-3 code-review fix: deriveReviewState reduces to each reviewer's *latest* review first
 * (grouped by user.login), then applies per-reviewer blocking semantics, instead of taking the
 * single latest review across all reviewers globally — which let a later APPROVED from one
 * reviewer silently clear an earlier, still-outstanding CHANGES_REQUESTED from another reviewer.
 */
describe('deriveReviewState (per-reviewer blocking semantics)', () => {
  it('stays changes_requested when Alice requests changes and Bob approves later', () => {
    const result = deriveReviewState([
      {
        state: 'CHANGES_REQUESTED',
        submitted_at: '2024-01-01T00:00:00Z',
        user: { login: 'alice' },
      },
      { state: 'APPROVED', submitted_at: '2024-01-02T00:00:00Z', user: { login: 'bob' } },
    ]);
    expect(result).toBe(PrReviewState.CHANGES_REQUESTED);
  });

  it('is no longer blocked by Alice once Alice herself later approves', () => {
    const result = deriveReviewState([
      {
        state: 'CHANGES_REQUESTED',
        submitted_at: '2024-01-01T00:00:00Z',
        user: { login: 'alice' },
      },
      { state: 'APPROVED', submitted_at: '2024-01-02T00:00:00Z', user: { login: 'alice' } },
    ]);
    expect(result).toBe(PrReviewState.APPROVED);
  });

  it('handles a mix of comments, approvals, and change requests across reviewers, blocking on the outstanding change request', () => {
    const result = deriveReviewState([
      { state: 'COMMENTED', submitted_at: '2024-01-01T00:00:00Z', user: { login: 'carol' } },
      { state: 'APPROVED', submitted_at: '2024-01-02T00:00:00Z', user: { login: 'bob' } },
      {
        state: 'CHANGES_REQUESTED',
        submitted_at: '2024-01-03T00:00:00Z',
        user: { login: 'alice' },
      },
    ]);
    expect(result).toBe(PrReviewState.CHANGES_REQUESTED);
  });

  it('reports approved once no reviewer has an outstanding change request', () => {
    const result = deriveReviewState([
      { state: 'COMMENTED', submitted_at: '2024-01-01T00:00:00Z', user: { login: 'carol' } },
      { state: 'APPROVED', submitted_at: '2024-01-02T00:00:00Z', user: { login: 'bob' } },
    ]);
    expect(result).toBe(PrReviewState.APPROVED);
  });

  it('returns none when there are no reviews', () => {
    expect(deriveReviewState([])).toBe(PrReviewState.NONE);
  });

  // HIGH-1 code-review fix: a reviewer's own later COMMENTED review must not silently clear their
  // own outstanding CHANGES_REQUESTED — only that same reviewer's later APPROVED or DISMISSED does.
  it('stays changes_requested when Alice requests changes then leaves a later COMMENTED review', () => {
    const result = deriveReviewState([
      {
        state: 'CHANGES_REQUESTED',
        submitted_at: '2024-01-01T00:00:00Z',
        user: { login: 'alice' },
      },
      { state: 'COMMENTED', submitted_at: '2024-01-02T00:00:00Z', user: { login: 'alice' } },
    ]);
    expect(result).toBe(PrReviewState.CHANGES_REQUESTED);
  });

  it('clears the block once Alice DISMISSES her own change request', () => {
    const result = deriveReviewState([
      {
        state: 'CHANGES_REQUESTED',
        submitted_at: '2024-01-01T00:00:00Z',
        user: { login: 'alice' },
      },
      { state: 'DISMISSED', submitted_at: '2024-01-02T00:00:00Z', user: { login: 'alice' } },
    ]);
    expect(result).toBe(PrReviewState.DISMISSED);
  });
});

/**
 * HIGH-2 code-review fix: `getPullRequest` now paginates `pulls.listReviews` and
 * `checks.listForRef` via `octokit.paginate` instead of a single unpaginated call, so a blocking
 * review or failing check run on page 2+ of a large PR is no longer silently dropped.
 */
describe('OctokitGitHubClient.getPullRequest (HIGH-2 pagination)', () => {
  afterEach(() => {
    vi.doUnmock('@octokit/rest');
    vi.resetModules();
  });

  it('picks up a blocking review and a failing check run that only exist on page 2', async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        number: 9,
        head: { ref: 'minicoder/FR-002', sha: 'sha2' },
        base: { ref: 'main' },
        merged: false,
        state: 'open',
        mergeable: true,
        labels: [],
        merged_at: null,
        merge_commit_sha: null,
        closed_at: null,
      },
    });
    const listReviews = vi.fn();
    const listForRef = vi.fn();
    const getCombinedStatusForRef = vi
      .fn()
      .mockResolvedValue({ data: { state: 'pending', total_count: 0 } });
    // `octokit.paginate` is a real method on the returned Octokit instance in production; the mock
    // here simulates its flattening behavior directly rather than mocking Link-header pagination.
    const paginate = vi.fn().mockImplementation(async (method: unknown) => {
      if (method === listReviews) {
        return [
          {
            state: 'APPROVED',
            submitted_at: '2024-01-01T00:00:00Z',
            user: { login: 'page1-reviewer' },
          },
          {
            state: 'CHANGES_REQUESTED',
            submitted_at: '2024-01-02T00:00:00Z',
            user: { login: 'page2-reviewer' },
          },
        ];
      }
      if (method === listForRef) {
        return [
          { status: 'completed', conclusion: 'success' },
          { status: 'completed', conclusion: 'failure' },
        ];
      }
      throw new Error(`unexpected paginate call: ${String(method)}`);
    });

    vi.doMock('@octokit/rest', () => ({
      Octokit: vi.fn().mockImplementation(() => ({
        pulls: { get: pullsGet, listReviews },
        checks: { listForRef },
        repos: { getCombinedStatusForRef },
        paginate,
      })),
    }));
    vi.resetModules();

    const { OctokitGitHubClient } = await import('./octokit-client.js');
    const client = new OctokitGitHubClient({ auth: 'token' });
    const observed = await client.getPullRequest('acme', 'widgets', 9);

    expect(observed?.reviewState).toBe(PrReviewState.CHANGES_REQUESTED);
    expect(observed?.ciStatus).toBe('failed');
  });
});

/**
 * HIGH-4 code-review fix: `neutral`/`skipped`/`stale` completed check-run conclusions are
 * completed-but-not-failing per GitHub's own semantics; `startup_failure` is a genuine failure
 * alongside `failure`/`timed_out`/`cancelled`/`action_required`.
 */
describe('deriveCiStatus (HIGH-4 conclusion classification)', () => {
  it('treats a neutral conclusion as passing, not failing', () => {
    expect(
      deriveCiStatus([{ status: 'completed', conclusion: 'neutral' }], {
        state: 'pending',
        total_count: 0,
      }),
    ).toBe('passed');
  });

  it('treats a skipped conclusion as passing, not failing', () => {
    expect(
      deriveCiStatus([{ status: 'completed', conclusion: 'skipped' }], {
        state: 'pending',
        total_count: 0,
      }),
    ).toBe('passed');
  });

  it('treats a stale conclusion as passing, not failing', () => {
    expect(
      deriveCiStatus([{ status: 'completed', conclusion: 'stale' }], {
        state: 'pending',
        total_count: 0,
      }),
    ).toBe('passed');
  });

  it('treats cancelled as a failure', () => {
    expect(
      deriveCiStatus([{ status: 'completed', conclusion: 'cancelled' }], {
        state: 'pending',
        total_count: 0,
      }),
    ).toBe('failed');
  });

  it('treats timed_out as a failure', () => {
    expect(
      deriveCiStatus([{ status: 'completed', conclusion: 'timed_out' }], {
        state: 'pending',
        total_count: 0,
      }),
    ).toBe('failed');
  });

  it('treats startup_failure as a failure', () => {
    expect(
      deriveCiStatus([{ status: 'completed', conclusion: 'startup_failure' }], {
        state: 'pending',
        total_count: 0,
      }),
    ).toBe('failed');
  });

  it('mixed inputs: a non-blocking conclusion alongside a real success still passes', () => {
    expect(
      deriveCiStatus(
        [
          { status: 'completed', conclusion: 'success' },
          { status: 'completed', conclusion: 'skipped' },
        ],
        { state: 'success', total_count: 1 },
      ),
    ).toBe('passed');
  });

  it('mixed inputs: a genuine failure alongside a non-blocking conclusion still fails', () => {
    expect(
      deriveCiStatus(
        [
          { status: 'completed', conclusion: 'neutral' },
          { status: 'completed', conclusion: 'action_required' },
        ],
        { state: 'success', total_count: 1 },
      ),
    ).toBe('failed');
  });
});

/**
 * HIGH-4 code-review fix: GitHub's REST API has no "conversations resolved" flag; getPullRequest
 * now reports a fail-closed `false` placeholder instead of hardcoding `true`.
 */
describe('OctokitGitHubClient.getPullRequest (HIGH-4 conversationsResolved placeholder)', () => {
  afterEach(() => {
    vi.doUnmock('@octokit/rest');
    vi.resetModules();
  });

  it('reports conversationsResolved: false (conservative placeholder, not a real observation)', async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        head: { ref: 'minicoder/FR-001', sha: 'sha1' },
        base: { ref: 'main' },
        merged: false,
        state: 'open',
        mergeable: true,
        labels: [],
        merged_at: null,
        merge_commit_sha: null,
        closed_at: null,
      },
    });
    const listReviews = vi.fn().mockResolvedValue({ data: [] });
    const listForRef = vi.fn().mockResolvedValue({ data: { check_runs: [] } });
    const getCombinedStatusForRef = vi
      .fn()
      .mockResolvedValue({ data: { state: 'pending', total_count: 0 } });
    // HIGH-2: getPullRequest now calls octokit.paginate for both listReviews/checks.listForRef.
    const paginate = vi.fn().mockImplementation(async (method: unknown) => {
      if (method === listReviews) return [];
      if (method === listForRef) return [];
      throw new Error(`unexpected paginate call: ${String(method)}`);
    });

    vi.doMock('@octokit/rest', () => ({
      Octokit: vi.fn().mockImplementation(() => ({
        pulls: { get: pullsGet, listReviews },
        checks: { listForRef },
        repos: { getCombinedStatusForRef },
        paginate,
      })),
    }));
    // vi.doMock is not hoisted: the module registry must be reset so the dynamic import below
    // re-evaluates octokit-client.ts (and its `@octokit/rest` import) against the mock instead of
    // reusing the already-cached real-Octokit-bound module from this file's static imports above.
    vi.resetModules();

    const { OctokitGitHubClient } = await import('./octokit-client.js');
    const client = new OctokitGitHubClient({ auth: 'token' });
    const observed = await client.getPullRequest('acme', 'widgets', 7);

    expect(observed?.conversationsResolved).toBe(false);
  });
});

/**
 * Phase 12 (Merge Gate): `mergePullRequest` classifies GitHub's merge-rejection status codes
 * into `GithubMergeRejectedError.reason`/`.autoClearable` — 409 (head moved since the gate
 * re-evaluated) is auto-clearable, 405 (branch protection or a real conflict — GitHub does not
 * distinguish the two) is not, and *any other* error (no HTTP status, or a status other than
 * 409/405 — e.g. 401/403/404/422/429/5xx) is rethrown as-is rather than misclassified as a
 * merge-gate rejection (code-review fix: an earlier version wrapped every other status into
 * `GithubMergeRejectedError('unknown', false)`, which would have driven `RecordMergeFailedCommand`
 * for a routine operational failure like a transient 500 or bad credentials).
 */
describe('OctokitGitHubClient.mergePullRequest', () => {
  afterEach(() => {
    vi.doUnmock('@octokit/rest');
    vi.resetModules();
  });

  async function buildClient(mergeImpl: () => Promise<unknown>) {
    vi.doMock('@octokit/rest', () => ({
      Octokit: vi.fn().mockImplementation(() => ({
        pulls: { merge: mergeImpl },
      })),
    }));
    vi.resetModules();
    const { OctokitGitHubClient } = await import('./octokit-client.js');
    return new OctokitGitHubClient({ auth: 'token' });
  }

  it('returns the merge SHA on success', async () => {
    const client = await buildClient(async () => ({ data: { sha: 'merged-sha-1' } }));
    const result = await client.mergePullRequest({
      owner: 'acme',
      repo: 'widgets',
      prNumber: 9,
      mergeMethod: 'squash',
    });
    expect(result).toEqual({ mergeSha: 'merged-sha-1' });
  });

  it('classifies a 409 as sha_mismatch (auto-clearable)', async () => {
    const client = await buildClient(async () => {
      const err = new Error('sha does not match') as Error & { status: number };
      err.status = 409;
      throw err;
    });
    await expect(
      client.mergePullRequest({
        owner: 'acme',
        repo: 'widgets',
        prNumber: 9,
        mergeMethod: 'squash',
      }),
    ).rejects.toMatchObject({
      reason: 'sha_mismatch',
      autoClearable: true,
    });
  });

  it('classifies a 405 as not_mergeable (not auto-clearable)', async () => {
    const client = await buildClient(async () => {
      const err = new Error('Pull Request is not mergeable') as Error & { status: number };
      err.status = 405;
      throw err;
    });
    await expect(
      client.mergePullRequest({
        owner: 'acme',
        repo: 'widgets',
        prNumber: 9,
        mergeMethod: 'squash',
      }),
    ).rejects.toMatchObject({
      reason: 'not_mergeable',
      autoClearable: false,
    });
  });

  it('rethrows an error with no HTTP status instead of misclassifying it as a merge rejection', async () => {
    const client = await buildClient(async () => {
      throw new Error('network unreachable');
    });
    await expect(
      client.mergePullRequest({
        owner: 'acme',
        repo: 'widgets',
        prNumber: 9,
        mergeMethod: 'squash',
      }),
    ).rejects.not.toBeInstanceOf(GithubMergeRejectedError);
  });

  it.each([401, 403, 404, 422, 429, 500, 503])(
    'rethrows a %i status instead of misclassifying it as a merge rejection',
    async (status) => {
      const client = await buildClient(async () => {
        const err = new Error(`operational failure ${status}`) as Error & { status: number };
        err.status = status;
        throw err;
      });
      await expect(
        client.mergePullRequest({
          owner: 'acme',
          repo: 'widgets',
          prNumber: 9,
          mergeMethod: 'squash',
        }),
      ).rejects.not.toBeInstanceOf(GithubMergeRejectedError);
    },
  );
});
