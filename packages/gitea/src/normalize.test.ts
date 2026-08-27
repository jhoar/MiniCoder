import { describe, it, expect } from 'vitest';
import { normalizeGiteaWebhookEvent } from './normalize.js';

const repo = { full_name: 'acme/widgets' };

describe('normalizeGiteaWebhookEvent', () => {
  it('maps pull_request opened → pr.opened', () => {
    const result = normalizeGiteaWebhookEvent('pull_request', {
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
    const result = normalizeGiteaWebhookEvent('pull_request', {
      action: 'reopened',
      repository: repo,
      pull_request: { number: 7, head: {}, base: {} },
    });
    expect(result?.eventType).toBe('pr.opened');
  });

  it('maps pull_request synchronized → pr.synchronized', () => {
    const result = normalizeGiteaWebhookEvent('pull_request', {
      action: 'synchronized',
      repository: repo,
      pull_request: { number: 7, head: { sha: 'def456' } },
    });
    expect(result?.eventType).toBe('pr.synchronized');
    expect(result?.payload).toMatchObject({ headSha: 'def456' });
  });

  it('maps pull_request closed (merged=false) → pr.closed', () => {
    const result = normalizeGiteaWebhookEvent('pull_request', {
      action: 'closed',
      repository: repo,
      pull_request: { number: 7, merged: false },
    });
    expect(result?.eventType).toBe('pr.closed');
  });

  it('maps pull_request closed (merged=true) → pr.merged', () => {
    const result = normalizeGiteaWebhookEvent('pull_request', {
      action: 'closed',
      repository: repo,
      pull_request: { number: 7, merged: true },
    });
    expect(result?.eventType).toBe('pr.merged');
  });

  it('ignores an unhandled pull_request action', () => {
    const result = normalizeGiteaWebhookEvent('pull_request', {
      action: 'labeled',
      repository: repo,
      pull_request: { number: 7 },
    });
    expect(result).toBeNull();
  });

  it('maps a submitted approve review → review.approved', () => {
    const result = normalizeGiteaWebhookEvent('pull_request_review', {
      action: 'submitted',
      repository: repo,
      pull_request: { number: 7 },
      review: { type: 'pull_request_review_approve' },
      reviewer: { login: 'alice' },
    });
    expect(result?.eventType).toBe('review.approved');
    expect(result?.payload).toMatchObject({ reviewer: 'alice' });
  });

  it('maps a submitted reject review → review.changes_requested', () => {
    const result = normalizeGiteaWebhookEvent('pull_request_review', {
      action: 'submitted',
      repository: repo,
      pull_request: { number: 7 },
      review: { type: 'pull_request_review_reject' },
    });
    expect(result?.eventType).toBe('review.changes_requested');
  });

  it('maps a submitted comment review → review.commented', () => {
    const result = normalizeGiteaWebhookEvent('pull_request_review', {
      action: 'submitted',
      repository: repo,
      pull_request: { number: 7 },
      review: { type: 'pull_request_review_comment' },
    });
    expect(result?.eventType).toBe('review.commented');
  });

  it('ignores a non-submitted pull_request_review action', () => {
    const result = normalizeGiteaWebhookEvent('pull_request_review', {
      action: 'dismissed',
      repository: repo,
      pull_request: { number: 7 },
      review: { type: 'pull_request_review_approve' },
    });
    expect(result).toBeNull();
  });

  it('maps pull_request_comment → review.comment', () => {
    const result = normalizeGiteaWebhookEvent('pull_request_comment', {
      repository: repo,
      pull_request: { number: 7 },
    });
    expect(result?.eventType).toBe('review.comment');
  });

  it('maps a success commit status → check.passed', () => {
    const result = normalizeGiteaWebhookEvent('status', {
      repository: repo,
      state: 'success',
      sha: 'abc123',
    });
    expect(result?.eventType).toBe('check.passed');
    expect(result?.prNumber).toBeNull();
  });

  it('maps a failure commit status → check.failed', () => {
    const result = normalizeGiteaWebhookEvent('status', {
      repository: repo,
      state: 'failure',
      sha: 'abc123',
    });
    expect(result?.eventType).toBe('check.failed');
  });

  it('ignores a pending commit status', () => {
    const result = normalizeGiteaWebhookEvent('status', {
      repository: repo,
      state: 'pending',
      sha: 'abc123',
    });
    expect(result).toBeNull();
  });

  it('maps push, stripping the refs/heads/ prefix', () => {
    const result = normalizeGiteaWebhookEvent('push', {
      repository: repo,
      ref: 'refs/heads/minicoder/fr-1',
      after: 'sha1',
    });
    expect(result?.eventType).toBe('push');
    expect(result?.payload).toMatchObject({ branchName: 'minicoder/fr-1', sha: 'sha1' });
  });

  it('returns null for an unrecognized event type', () => {
    const result = normalizeGiteaWebhookEvent('issues', { repository: repo });
    expect(result).toBeNull();
  });
});
