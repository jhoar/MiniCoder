import { describe, it, expect } from 'vitest';
import { normalizeGithubWebhookEvent } from './normalize.js';

const repo = { full_name: 'acme/widgets' };

describe('normalizeGithubWebhookEvent', () => {
  it('maps pull_request opened → pr.opened', () => {
    const result = normalizeGithubWebhookEvent('pull_request', {
      action: 'opened',
      repository: repo,
      pull_request: {
        number: 7,
        head: { ref: 'minicoder/FR-001', sha: 'abc123' },
        base: { ref: 'main' },
      },
    });
    expect(result?.eventType).toBe('pr.opened');
    expect(result?.prNumber).toBe(7);
    expect(result?.payload).toMatchObject({
      branchName: 'minicoder/FR-001',
      baseBranch: 'main',
      headSha: 'abc123',
    });
  });

  it('maps pull_request reopened → pr.opened', () => {
    const result = normalizeGithubWebhookEvent('pull_request', {
      action: 'reopened',
      repository: repo,
      pull_request: { number: 7, head: {}, base: {} },
    });
    expect(result?.eventType).toBe('pr.opened');
  });

  it('maps pull_request synchronize → pr.synchronized', () => {
    const result = normalizeGithubWebhookEvent('pull_request', {
      action: 'synchronize',
      repository: repo,
      pull_request: { number: 7, head: { sha: 'def456' } },
    });
    expect(result?.eventType).toBe('pr.synchronized');
  });

  it('maps pull_request closed+merged → pr.merged', () => {
    const result = normalizeGithubWebhookEvent('pull_request', {
      action: 'closed',
      repository: repo,
      pull_request: { number: 7, merged: true },
    });
    expect(result?.eventType).toBe('pr.merged');
  });

  it('maps pull_request closed+not-merged → pr.closed', () => {
    const result = normalizeGithubWebhookEvent('pull_request', {
      action: 'closed',
      repository: repo,
      pull_request: { number: 7, merged: false },
    });
    expect(result?.eventType).toBe('pr.closed');
  });

  it('ignores pull_request actions MiniCoder does not act on', () => {
    const result = normalizeGithubWebhookEvent('pull_request', {
      action: 'labeled',
      repository: repo,
      pull_request: { number: 7 },
    });
    expect(result).toBeNull();
  });

  it('maps pull_request_review submitted+approved → review.approved', () => {
    const result = normalizeGithubWebhookEvent('pull_request_review', {
      action: 'submitted',
      repository: repo,
      pull_request: { number: 7 },
      review: { state: 'approved', user: { login: 'alice' } },
    });
    expect(result?.eventType).toBe('review.approved');
    expect(result?.payload.reviewer).toBe('alice');
  });

  it('maps pull_request_review submitted+changes_requested → review.changes_requested', () => {
    const result = normalizeGithubWebhookEvent('pull_request_review', {
      action: 'submitted',
      repository: repo,
      pull_request: { number: 7 },
      review: { state: 'changes_requested' },
    });
    expect(result?.eventType).toBe('review.changes_requested');
  });

  it('maps pull_request_review dismissed → review.dismissed', () => {
    const result = normalizeGithubWebhookEvent('pull_request_review', {
      action: 'dismissed',
      repository: repo,
      pull_request: { number: 7 },
    });
    expect(result?.eventType).toBe('review.dismissed');
  });

  it('maps check_run completed+success → check.passed', () => {
    const result = normalizeGithubWebhookEvent('check_run', {
      action: 'completed',
      repository: repo,
      check_run: { id: 99, conclusion: 'success', pull_requests: [{ number: 7 }] },
    });
    expect(result?.eventType).toBe('check.passed');
    expect(result?.prNumber).toBe(7);
  });

  it('maps check_run completed+failure → check.failed', () => {
    const result = normalizeGithubWebhookEvent('check_run', {
      action: 'completed',
      repository: repo,
      check_run: { id: 99, conclusion: 'failure', pull_requests: [{ number: 7 }] },
    });
    expect(result?.eventType).toBe('check.failed');
  });

  it('ignores check_run in-progress (not completed)', () => {
    const result = normalizeGithubWebhookEvent('check_run', {
      action: 'created',
      repository: repo,
      check_run: { id: 99, conclusion: null },
    });
    expect(result).toBeNull();
  });

  it('maps status success → check.passed', () => {
    const result = normalizeGithubWebhookEvent('status', {
      repository: repo,
      state: 'success',
      sha: 'abc123',
    });
    expect(result?.eventType).toBe('check.passed');
  });

  it('maps status failure → check.failed', () => {
    const result = normalizeGithubWebhookEvent('status', {
      repository: repo,
      state: 'failure',
      sha: 'abc123',
    });
    expect(result?.eventType).toBe('check.failed');
  });

  it('maps push → push', () => {
    const result = normalizeGithubWebhookEvent('push', {
      repository: repo,
      ref: 'refs/heads/main',
      sha: 'abc123',
    });
    expect(result?.eventType).toBe('push');
  });

  it('HIGH-5: a realistic push payload (ref + after, no sha field) normalizes to a bare branchName and the after SHA', () => {
    const result = normalizeGithubWebhookEvent('push', {
      repository: repo,
      ref: 'refs/heads/minicoder/FR-002',
      after: 'deadbeef',
      // Real GitHub push webhooks have no top-level `sha` field at all.
    });
    expect(result?.eventType).toBe('push');
    expect(result?.payload).toEqual({ branchName: 'minicoder/FR-002', sha: 'deadbeef' });
  });

  it('returns null for unrecognized event names', () => {
    const result = normalizeGithubWebhookEvent('deployment', { repository: repo });
    expect(result).toBeNull();
  });
});
