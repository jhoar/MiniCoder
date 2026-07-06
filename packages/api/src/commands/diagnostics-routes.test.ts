import { describe, it, expect } from 'vitest';
import {
  buildTestApp,
  TEST_OPERATOR_KEY,
  TEST_VIEWER_KEY,
  seedProjectWithWorkflowState,
} from '../test-helpers.js';

describe('diagnostics command routes', () => {
  it('POST /commands/validate returns a healthy result for a clean DB', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const res = await app.inject({
      method: 'POST',
      url: '/commands/validate',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { projectId },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ valid: true, checkedRuns: 0 });
  });

  it('POST /commands/doctor reports healthy for a clean DB', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/commands/doctor',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).healthy).toBe(true);
  });

  it('POST /commands/reconcile requires projectId or all', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/commands/reconcile',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /commands/reconcile requires an Idempotency-Key header', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/commands/reconcile',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { all: true },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).type).toBe('missing-idempotency-key');
  });

  it('POST /commands/reconcile replays the cached result on a repeated Idempotency-Key (finding 2)', async () => {
    const { app } = await buildTestApp();
    const first = await app.inject({
      method: 'POST',
      url: '/commands/reconcile',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'reconcile-replay-1',
      },
      payload: { all: true },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/commands/reconcile',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'reconcile-replay-1',
      },
      payload: { all: true },
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
  });

  it('POST /commands/reconcile returns 409 for a same-key request while another is still in-flight', async () => {
    const { app, db } = await buildTestApp();
    const { claimRouteIdempotencyKey } = await import('../route-idempotency.js');
    // Simulate a concurrent in-flight request by claiming the key ourselves first, without
    // fulfilling it — mirrors the state a real concurrent request would leave mid-flight.
    await claimRouteIdempotencyKey(db, 'reconcile-in-flight', 'reconcile-route', 60_000);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/reconcile',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'reconcile-in-flight',
      },
      payload: { all: true },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).type).toBe('request-in-progress');
  });

  it('POST /commands/export-diagnostics returns a diagnostics snapshot', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const res = await app.inject({
      method: 'POST',
      url: '/commands/export-diagnostics',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { projectId },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.project.id).toBe(projectId);
    expect(body.globalOperationalState.scope).toBe('global');
  });

  it.each(['validate', 'doctor', 'reconcile', 'export-diagnostics'])(
    'rejects a viewer-role key from calling POST /commands/%s (finding 3)',
    async (route) => {
      const { app, db } = await buildTestApp();
      const { projectId } = await seedProjectWithWorkflowState(db);
      const res = await app.inject({
        method: 'POST',
        url: `/commands/${route}`,
        headers: { authorization: `Bearer ${TEST_VIEWER_KEY}` },
        payload: { projectId, all: true },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).type).toBe('authorization-error');
    },
  );
});
