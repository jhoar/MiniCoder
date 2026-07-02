import { describe, it, expect, vi, afterEach } from 'vitest';
import { deriveCiStatus, deriveReviewState } from './octokit-client.js';
import { PrReviewState } from '@minicoder/core';

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

    vi.doMock('@octokit/rest', () => ({
      Octokit: vi.fn().mockImplementation(() => ({
        pulls: { get: pullsGet, listReviews },
        checks: { listForRef },
        repos: { getCombinedStatusForRef },
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
