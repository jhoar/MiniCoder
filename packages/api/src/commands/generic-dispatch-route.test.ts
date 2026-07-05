import { describe, it, expect } from 'vitest';
import {
  buildTestApp,
  TEST_OPERATOR_KEY,
  TEST_VIEWER_KEY,
  seedProjectWithWorkflowState,
} from '../test-helpers.js';

describe('generic command dispatch route', () => {
  it('dispatches a registered command and returns the command envelope response', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/pause-automation',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'pause-key-1',
      },
      payload: { projectId, expectedVersion: 1 },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      accepted: true,
      resulting_state: 'paused_by_operator',
    });
    expect(typeof body.command_id).toBe('string');
    expect(Array.isArray(body.emitted_event_ids)).toBe(true);
  });

  it('replays the cached result on a repeated Idempotency-Key without re-running side effects', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);

    const first = await app.inject({
      method: 'POST',
      url: '/commands/pause-automation',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'pause-key-replay',
      },
      payload: { projectId, expectedVersion: 1 },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);

    // A naive retry with a *stale* expectedVersion would normally fail an optimistic-lock check —
    // proving the second call never re-executed the handler, only replayed the cached result.
    const second = await app.inject({
      method: 'POST',
      url: '/commands/pause-automation',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'pause-key-replay',
      },
      payload: { projectId, expectedVersion: 1 },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body);
    expect(secondBody).toEqual(firstBody);
  });

  it('rejects a command request from an under-privileged actor with 403', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/pause-automation',
      headers: {
        authorization: `Bearer ${TEST_VIEWER_KEY}`,
        'idempotency-key': 'pause-key-viewer',
      },
      payload: { projectId, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).type).toBe('authorization-error');
  });

  it('rejects a mutating request with no Idempotency-Key header', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/pause-automation',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { projectId, expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).type).toBe('missing-idempotency-key');
  });

  it('returns 404 for an unknown command slug', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/commands/not-a-real-command',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'whatever',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists registered command slugs via GET /commands', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/commands',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.commands).toContain('pause-automation');
    expect(body.commands).toContain('approve-plan');
  });
});
