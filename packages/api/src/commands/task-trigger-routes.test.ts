import { describe, it, expect } from 'vitest';
import { buildTestApp, TEST_OPERATOR_KEY, TEST_VIEWER_KEY } from '../test-helpers.js';
import type { TaskTriggerClient } from './task-trigger-routes.js';

function fakeTaskTriggerClient(): TaskTriggerClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    triggerRunCoder: async (payload) => {
      calls.push({ task: 'run-coder', payload });
      return { triggerdevRunId: 'run-coder-1' };
    },
    triggerRunReview: async (payload) => {
      calls.push({ task: 'run-review', payload });
      return { triggerdevRunId: 'run-review-1' };
    },
    triggerRunMergeGate: async (payload) => {
      calls.push({ task: 'run-merge-gate', payload });
      return { triggerdevRunId: 'run-merge-gate-1' };
    },
    triggerRunDesignDoc: async (payload) => {
      calls.push({ task: 'run-design-doc', payload });
      return { triggerdevRunId: 'run-design-doc-1' };
    },
  };
}

describe('task-trigger enqueue routes', () => {
  it('POST /commands/request-coder-run calls the injected client and returns 202', async () => {
    const client = fakeTaskTriggerClient();
    const { app } = await buildTestApp({ taskTriggerClient: client });

    const res = await app.inject({
      method: 'POST',
      url: '/commands/request-coder-run',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'req-coder-1',
      },
      payload: {
        projectId: 'proj-1',
        featureRunId: 'run-1',
        coderAdapterName: 'CodexCoderAdapter',
      },
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ triggerdevRunId: 'run-coder-1', accepted: true });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ task: 'run-coder' });
  });

  it('POST /commands/request-review calls the injected client', async () => {
    const client = fakeTaskTriggerClient();
    const { app } = await buildTestApp({ taskTriggerClient: client });

    const res = await app.inject({
      method: 'POST',
      url: '/commands/request-review',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'req-review-1',
      },
      payload: {
        projectId: 'proj-1',
        featureRunId: 'run-1',
        reviewerAdapterName: 'ClaudeReviewerAdapter',
      },
    });

    expect(res.statusCode).toBe(202);
    expect(client.calls[0]).toMatchObject({ task: 'run-review' });
  });

  it('POST /commands/request-fixes also re-triggers run-review (confirmed scope decision)', async () => {
    const client = fakeTaskTriggerClient();
    const { app } = await buildTestApp({ taskTriggerClient: client });

    const res = await app.inject({
      method: 'POST',
      url: '/commands/request-fixes',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'req-fixes-1',
      },
      payload: {
        projectId: 'proj-1',
        featureRunId: 'run-1',
        reviewerAdapterName: 'ClaudeReviewerAdapter',
      },
    });

    expect(res.statusCode).toBe(202);
    expect(client.calls[0]).toMatchObject({ task: 'run-review' });
  });

  it('POST /commands/recompute-merge-gate calls the injected client', async () => {
    const client = fakeTaskTriggerClient();
    const { app } = await buildTestApp({ taskTriggerClient: client });

    const res = await app.inject({
      method: 'POST',
      url: '/commands/recompute-merge-gate',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'recompute-1',
      },
      payload: { projectId: 'proj-1', featureRunId: 'run-1' },
    });

    expect(res.statusCode).toBe(202);
    expect(client.calls[0]).toMatchObject({ task: 'run-merge-gate' });
  });

  it('POST /commands/request-design-doc calls the injected client', async () => {
    const client = fakeTaskTriggerClient();
    const { app } = await buildTestApp({ taskTriggerClient: client });

    const res = await app.inject({
      method: 'POST',
      url: '/commands/request-design-doc',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'request-design-doc-1',
      },
      payload: { projectId: 'proj-1', documentationAdapterName: 'ClaudeDocumentationAdapter' },
    });

    expect(res.statusCode).toBe(202);
    expect(client.calls[0]).toMatchObject({ task: 'run-design-doc' });
  });

  it.each([
    ['request-coder-run', { coderAdapterName: 'CodexCoderAdapter' }],
    ['request-review', { reviewerAdapterName: 'ClaudeReviewerAdapter' }],
    ['request-fixes', { reviewerAdapterName: 'ClaudeReviewerAdapter' }],
    ['recompute-merge-gate', {}],
    ['request-design-doc', { documentationAdapterName: 'ClaudeDocumentationAdapter' }],
  ])(
    'rejects a viewer-role key from calling POST /commands/%s (finding 2)',
    async (route, extraFields) => {
      const client = fakeTaskTriggerClient();
      const { app } = await buildTestApp({ taskTriggerClient: client });

      const res = await app.inject({
        method: 'POST',
        url: `/commands/${route}`,
        headers: {
          authorization: `Bearer ${TEST_VIEWER_KEY}`,
          'idempotency-key': `viewer-${route}`,
        },
        payload: { projectId: 'proj-1', featureRunId: 'run-1', ...extraFields },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).type).toBe('authorization-error');
      expect(client.calls).toHaveLength(0);
    },
  );

  it('fails with a redacted 500 when no TaskTriggerClient is configured', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/commands/request-coder-run',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'req-coder-unconfigured',
      },
      payload: {
        projectId: 'proj-1',
        featureRunId: 'run-1',
        coderAdapterName: 'CodexCoderAdapter',
      },
    });
    expect(res.statusCode).toBe(500);
    // The actionable "No TaskTriggerClient configured..." message is logged server-side (see
    // errors.ts) but must not be echoed to the client — only a stable, generic body is returned.
    const body = JSON.parse(res.body);
    expect(body.type).toBe('internal-error');
    expect(body.detail).not.toContain('No TaskTriggerClient configured');
  });
});
