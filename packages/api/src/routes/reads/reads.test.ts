import { describe, it, expect } from 'vitest';
import {
  buildTestApp,
  TEST_OPERATOR_KEY,
  TEST_VIEWER_KEY,
  seedProjectWithWorkflowState,
  seedHumanRequiredFeatureRun,
  seedTriggerdevRun,
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
    expect(body.workflowState.version).toBe(1);
  });

  it('GET /whoami echoes the resolved actor identity', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: `Bearer ${TEST_VIEWER_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      id: 'test-viewer',
      role: 'viewer',
      actorKind: 'human',
    });
  });

  it('GET /human-required-items requires a projectId query parameter', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/human-required-items',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /human-required-items lists feature runs parked at human_required', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { featureRunId } = await seedHumanRequiredFeatureRun(db, projectId);
    const res = await app.inject({
      method: 'GET',
      url: `/human-required-items?projectId=${projectId}`,
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      feature_run_id: featureRunId,
      fr_id: 'FR-001',
      title: 'Test Feature',
      current_execution_state: 'human_required',
    });
  });

  it('GET /triggerdev-runs filters by projectId', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { projectId: otherProjectId } = await seedProjectWithWorkflowState(db);
    await seedTriggerdevRun(db, { projectId, status: 'running' });
    await seedTriggerdevRun(db, { projectId: otherProjectId, status: 'failed' });

    const res = await app.inject({
      method: 'GET',
      url: `/triggerdev-runs?projectId=${projectId}`,
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ project_id: projectId, triggerdev_status: 'running' });
  });

  it('GET /feature-runs/:id/timeline returns an empty entry list for an unknown feature run', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/feature-runs/does-not-exist/timeline',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ featureRunId: 'does-not-exist', entries: [] });
  });

  it('GET /budget-report requires a projectId query parameter', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/budget-report',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /budget-report returns a zeroed report for a project with no cost_records', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const res = await app.inject({
      method: 'GET',
      url: `/budget-report?projectId=${projectId}`,
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ projectId, totalAmount: 0, recordCount: 0 });
  });

  // Post-merge PR review fix (LOW-1): windowDays is documented as `type: integer` in the OpenAPI
  // spec; a decimal value must be rejected rather than silently accepted.
  it('GET /budget-report rejects a non-integer windowDays', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const res = await app.inject({
      method: 'GET',
      url: `/budget-report?projectId=${projectId}&windowDays=1.5`,
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
