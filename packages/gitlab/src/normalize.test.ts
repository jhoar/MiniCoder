import { describe, it, expect } from 'vitest';
import { normalizeGitlabWebhookEvent } from './normalize.js';

const project = { path_with_namespace: 'acme/widgets' };

describe('normalizeGitlabWebhookEvent', () => {
  it('maps merge_request open → pr.opened', () => {
    const result = normalizeGitlabWebhookEvent('merge_request', {
      object_kind: 'merge_request',
      project,
      object_attributes: {
        iid: 7,
        action: 'open',
        source_branch: 'minicoder/fr-1',
        target_branch: 'main',
        last_commit: { id: 'abc123' },
      },
    });
    expect(result?.eventType).toBe('pr.opened');
    expect(result?.prNumber).toBe(7);
    expect(result?.payload).toMatchObject({
      branchName: 'minicoder/fr-1',
      baseBranch: 'main',
      headSha: 'abc123',
    });
  });

  it('maps merge_request reopen → pr.opened', () => {
    const result = normalizeGitlabWebhookEvent('merge_request', {
      object_kind: 'merge_request',
      project,
      object_attributes: { iid: 7, action: 'reopen' },
    });
    expect(result?.eventType).toBe('pr.opened');
  });

  it('maps merge_request update with oldrev → pr.synchronized', () => {
    const result = normalizeGitlabWebhookEvent('merge_request', {
      object_kind: 'merge_request',
      project,
      object_attributes: {
        iid: 7,
        action: 'update',
        oldrev: 'old123',
        last_commit: { id: 'new456' },
      },
    });
    expect(result?.eventType).toBe('pr.synchronized');
    expect(result?.payload).toMatchObject({ headSha: 'new456' });
  });

  it('ignores merge_request update with no oldrev (e.g. a label/title edit)', () => {
    const result = normalizeGitlabWebhookEvent('merge_request', {
      object_kind: 'merge_request',
      project,
      object_attributes: { iid: 7, action: 'update' },
    });
    expect(result).toBeNull();
  });

  it('maps merge_request close → pr.closed', () => {
    const result = normalizeGitlabWebhookEvent('merge_request', {
      object_kind: 'merge_request',
      project,
      object_attributes: { iid: 7, action: 'close' },
    });
    expect(result?.eventType).toBe('pr.closed');
  });

  it('maps merge_request merge → pr.merged', () => {
    const result = normalizeGitlabWebhookEvent('merge_request', {
      object_kind: 'merge_request',
      project,
      object_attributes: { iid: 7, action: 'merge' },
    });
    expect(result?.eventType).toBe('pr.merged');
  });

  it('maps merge_request approved → review.approved', () => {
    const result = normalizeGitlabWebhookEvent('merge_request', {
      object_kind: 'merge_request',
      project,
      object_attributes: { iid: 7, action: 'approved' },
      user: { username: 'alice' },
    });
    expect(result?.eventType).toBe('review.approved');
    expect(result?.payload).toMatchObject({ reviewer: 'alice' });
  });

  it('never produces review.changes_requested — GitLab has no such webhook action', () => {
    // Exhaustively check every documented merge_request action produces something other than
    // review.changes_requested (most produce null or a different event type).
    const actions = ['open', 'reopen', 'close', 'merge', 'approved', 'unapproved', 'update'];
    for (const action of actions) {
      const result = normalizeGitlabWebhookEvent('merge_request', {
        object_kind: 'merge_request',
        project,
        object_attributes: { iid: 7, action },
      });
      expect(result?.eventType).not.toBe('review.changes_requested');
    }
  });

  it('maps a successful pipeline → check.passed with no PR number', () => {
    const result = normalizeGitlabWebhookEvent('pipeline', {
      object_kind: 'pipeline',
      project,
      object_attributes: { status: 'success', sha: 'abc123' },
    });
    expect(result?.eventType).toBe('check.passed');
    expect(result?.prNumber).toBeNull();
  });

  it('maps a failed pipeline → check.failed', () => {
    const result = normalizeGitlabWebhookEvent('pipeline', {
      object_kind: 'pipeline',
      project,
      object_attributes: { status: 'failed', sha: 'abc123' },
    });
    expect(result?.eventType).toBe('check.failed');
  });

  it('ignores a running pipeline', () => {
    const result = normalizeGitlabWebhookEvent('pipeline', {
      object_kind: 'pipeline',
      project,
      object_attributes: { status: 'running', sha: 'abc123' },
    });
    expect(result).toBeNull();
  });

  it('maps a note on a merge request → review.comment', () => {
    const result = normalizeGitlabWebhookEvent('note', {
      object_kind: 'note',
      project,
      object_attributes: { noteable_type: 'MergeRequest' },
      merge_request: { iid: 7 },
    });
    expect(result?.eventType).toBe('review.comment');
    expect(result?.prNumber).toBe(7);
  });

  it('ignores a note on something other than a merge request', () => {
    const result = normalizeGitlabWebhookEvent('note', {
      object_kind: 'note',
      project,
      object_attributes: { noteable_type: 'Issue' },
    });
    expect(result).toBeNull();
  });

  it('maps push, stripping the refs/heads/ prefix', () => {
    const result = normalizeGitlabWebhookEvent('push', {
      object_kind: 'push',
      project,
      ref: 'refs/heads/minicoder/fr-1',
      after: 'sha1',
    });
    expect(result?.eventType).toBe('push');
    expect(result?.payload).toMatchObject({ branchName: 'minicoder/fr-1', sha: 'sha1' });
  });

  it('returns null for an unrecognized object_kind', () => {
    const result = normalizeGitlabWebhookEvent('issue', { project });
    expect(result).toBeNull();
  });
});
