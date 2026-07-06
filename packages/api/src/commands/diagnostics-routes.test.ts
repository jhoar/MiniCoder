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

  // Issue #52: a feature run at approved_pending_execution depending (via feature_dependencies)
  // on a feature whose run has been transitioned to 'skipped' can never satisfy the merged-
  // dependency guard. state doctor's skipped_dependency check flags this as defense-in-depth for
  // any case that predates SkipFeatureHandler's proactive cascade-to-blocked fix.
  it('POST /commands/doctor flags skipped_dependency for a dependent stuck on a skipped feature', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const now = new Date().toISOString();
    const planId = `plan-${projectId}`;
    const targetFrId = `fr-${projectId}-target`;
    const sourceFrId = `fr-${projectId}-source`;

    await db.execute(
      `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, ?, ?)`,
      [planId, projectId, now, now],
    );
    await db.execute(
      `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-TARGET', 'Target feature', 'Description', 'feature', 1, 'skipped', 0, 1, ?, ?)`,
      [targetFrId, planId, projectId, now, now],
    );
    await db.execute(
      `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-SOURCE', 'Dependent feature', 'Description', 'feature', 1, 'approved_pending_execution', 0, 1, ?, ?)`,
      [sourceFrId, planId, projectId, now, now],
    );
    await db.execute(
      `INSERT INTO feature_dependencies (id, source_fr_id, target_fr_id, created_at) VALUES (?, ?, ?, ?)`,
      [`dep-${projectId}`, sourceFrId, targetFrId, now],
    );
    await db.execute(
      `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, 'skipped', 1, ?, ?)`,
      [`run-${projectId}-target`, targetFrId, now, now],
    );
    await db.execute(
      `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, 'approved_pending_execution', 1, ?, ?)`,
      [`run-${projectId}-source`, sourceFrId, now, now],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/commands/doctor',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { projectId },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.healthy).toBe(false);
    const check = body.checks.find((c: { name: string }) => c.name === 'skipped_dependency');
    expect(check).toMatchObject({ severity: 'error', count: 1 });
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
