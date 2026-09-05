import { describe, it, expect } from 'vitest';
import { buildTestApp, TEST_OPERATOR_KEY, TEST_VIEWER_KEY } from '../test-helpers.js';
import type { TaskTriggerClient } from './task-trigger-routes.js';

function fakeTaskTriggerClient(): TaskTriggerClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    triggerReadinessAssessment: async (payload) => {
      calls.push({ task: 'planning-readiness-assessment', payload });
      return { triggerdevRunId: 'readiness-1' };
    },
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

  it('POST /commands/request-readiness-assessment looks up the most recent specification_inputs row and calls the injected client', async () => {
    const client = fakeTaskTriggerClient();
    const { app, db } = await buildTestApp({ taskTriggerClient: client });
    await db.execute(`INSERT INTO projects (id, name) VALUES (?, ?)`, ['proj-1', 'Test Project']);
    await db.execute(
      `INSERT INTO specification_inputs (id, project_id, content) VALUES (?, ?, ?)`,
      ['spec-older', 'proj-1', 'older spec'],
    );
    await db.execute(
      `INSERT INTO specification_inputs (id, project_id, content, created_at) VALUES (?, ?, ?, ?)`,
      ['spec-newer', 'proj-1', 'newest spec content', '2099-01-01T00:00:00.000Z'],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/commands/request-readiness-assessment',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'request-readiness-1',
      },
      payload: { projectId: 'proj-1', plannerAdapterName: 'GenericLLMPlannerAdapter' },
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ triggerdevRunId: 'readiness-1', accepted: true });
    expect(client.calls[0]).toMatchObject({
      task: 'planning-readiness-assessment',
      payload: {
        projectId: 'proj-1',
        specificationInputId: 'spec-newer',
        specificationContent: 'newest spec content',
        plannerAdapterName: 'GenericLLMPlannerAdapter',
      },
    });
  });

  it('POST /commands/request-readiness-assessment returns 404 when no specification has been ingested yet', async () => {
    const client = fakeTaskTriggerClient();
    const { app, db } = await buildTestApp({ taskTriggerClient: client });
    await db.execute(`INSERT INTO projects (id, name) VALUES (?, ?)`, ['proj-1', 'Test Project']);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/request-readiness-assessment',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'request-readiness-404',
      },
      payload: { projectId: 'proj-1', plannerAdapterName: 'GenericLLMPlannerAdapter' },
    });

    expect(res.statusCode).toBe(404);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['request-readiness-assessment', { plannerAdapterName: 'GenericLLMPlannerAdapter' }],
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
