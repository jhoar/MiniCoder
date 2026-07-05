import { describe, it, expect } from 'vitest';
import {
  buildTestApp,
  TEST_OPERATOR_KEY,
  seedProjectWithWorkflowState,
} from '../../test-helpers.js';

describe('read endpoints', () => {
  it('GET /projects returns a cursor page including the seeded project', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);

    const res = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('nextCursor');
    expect(body.items.some((p: { id: string }) => p.id === projectId)).toBe(true);
  });

  it('GET /projects/:id returns 404 for an unknown project', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/projects/does-not-exist',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /active-feature requires a projectId query parameter', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/active-feature',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /active-feature reports automation state for a seeded project', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db, { automationState: 'running' });
    const res = await app.inject({
      method: 'GET',
      url: `/active-feature?projectId=${projectId}`,
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      automationState: 'running',
      activeFeatureRun: null,
    });
  });

  it('GET /status returns a project health summary', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const res = await app.inject({
      method: 'GET',
      url: `/status?projectId=${projectId}`,
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.project.id).toBe(projectId);
    expect(body.pendingOutboxCount).toBe(0);
  });
});
