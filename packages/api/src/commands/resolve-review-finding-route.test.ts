import { describe, it, expect } from 'vitest';
import { generateId } from '@minicoder/core';
import type { DbClient } from '@minicoder/core';
import {
  buildTestApp,
  TEST_OPERATOR_KEY,
  TEST_VIEWER_KEY,
  seedProjectWithWorkflowState,
  seedHumanRequiredFeatureRun,
} from '../test-helpers.js';

async function seedFinding(db: DbClient, featureRunId: string): Promise<string> {
  const findingId = generateId();
  await db.execute(
    `INSERT INTO review_findings (id, feature_run_id, reviewer_run_id, review_cycle, severity, category, description, resolved, version, created_at, updated_at)
     VALUES (?, ?, NULL, 1, 'non_blocking', 'style', 'A non-blocking finding', 0, 1, datetime('now'), datetime('now'))`,
    [findingId, featureRunId],
  );
  return findingId;
}

describe('POST /commands/resolve-review-finding', () => {
  it('requires operator role or higher', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { featureRunId } = await seedHumanRequiredFeatureRun(db, projectId);
    const findingId = await seedFinding(db, featureRunId);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/resolve-review-finding',
      headers: { authorization: `Bearer ${TEST_VIEWER_KEY}` },
      payload: { findingId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires findingId', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/commands/resolve-review-finding',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown finding', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/commands/resolve-review-finding',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { findingId: 'does-not-exist' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('records a deferred disposition and leaves resolved false when dismiss is omitted', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { featureRunId } = await seedHumanRequiredFeatureRun(db, projectId);
    const findingId = await seedFinding(db, featureRunId);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/resolve-review-finding',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { findingId, note: 'still wants a fix' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ findingId, dismissed: false, alreadyResolved: false });

    const rows = await db.query<{ resolved: number }>(
      `SELECT resolved FROM review_findings WHERE id = ?`,
      [findingId],
    );
    expect(Boolean(rows[0]?.resolved)).toBe(false);
  });

  it('dismisses a finding and flips resolved to true', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { featureRunId } = await seedHumanRequiredFeatureRun(db, projectId);
    const findingId = await seedFinding(db, featureRunId);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/resolve-review-finding',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { findingId, dismiss: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ findingId, dismissed: true, alreadyResolved: false });

    const rows = await db.query<{ resolved: number }>(
      `SELECT resolved FROM review_findings WHERE id = ?`,
      [findingId],
    );
    expect(Boolean(rows[0]?.resolved)).toBe(true);
  });
});
