import { describe, it, expect } from 'vitest';
import { deriveCiStatus } from './octokit-client.js';

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
