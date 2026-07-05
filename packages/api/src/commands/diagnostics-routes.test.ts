import { describe, it, expect } from 'vitest';
import { buildTestApp, TEST_OPERATOR_KEY, seedProjectWithWorkflowState } from '../test-helpers.js';

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
});
