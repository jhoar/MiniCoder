import { describe, it, expect } from 'vitest';
import { buildTestApp, TEST_OPERATOR_KEY } from '../test-helpers.js';
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

  it('fails fast with an actionable error when no TaskTriggerClient is configured', async () => {
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
    expect(JSON.parse(res.body).detail).toContain('No TaskTriggerClient configured');
  });
});
