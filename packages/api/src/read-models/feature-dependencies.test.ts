import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import type { DbClient } from '@minicoder/core';
import { listFeatureRequests, getFeatureRequest } from './features.js';

/**
 * Previously there was no way to see a feature's declared dependencies (feature_dependencies)
 * from any API/CLI response — confirmed live against a real generated backlog, where the only
 * way to check was a raw sqlite3 query against the database file. Proves depends_on_fr_ids is
 * populated correctly (translated from the internal target id to its fr_id label) and scoped to
 * the requesting feature only.
 */

const PROJECT_ID = 'proj-feature-deps';
const PLAN_ID = 'plan-feature-deps';

async function seedFeature(db: DbClient, id: string, frId: string, priority: number): Promise<void> {
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Title', 'Description', 'feature', 1, 'approved_pending_execution', ?, 1, datetime('now'), datetime('now'))`,
    [id, PLAN_ID, PROJECT_ID, frId, priority],
  );
}

describe('feature dependencies (depends_on_fr_ids)', () => {
  it('listFeatureRequests populates depends_on_fr_ids, scoped to each feature only', async () => {
    const db = createTestDb();
    await db.execute(`INSERT INTO projects (id, name) VALUES (?, ?)`, [PROJECT_ID, 'Test']);
    await db.execute(
      `INSERT INTO implementation_plans (id, project_id, state, title, version, created_at, updated_at)
       VALUES (?, ?, 'draft', 'Test Plan', 1, datetime('now'), datetime('now'))`,
      [PLAN_ID, PROJECT_ID],
    );
    await seedFeature(db, 'feat-1', 'FR-001', 1);
    await seedFeature(db, 'feat-2', 'FR-002', 2);
    await seedFeature(db, 'feat-3', 'FR-003', 3);

    // FR-002 depends on FR-001; FR-003 depends on both FR-001 and FR-002.
    await db.execute(
      `INSERT INTO feature_dependencies (id, source_fr_id, target_fr_id) VALUES (?, ?, ?)`,
      ['dep-1', 'feat-2', 'feat-1'],
    );
    await db.execute(
      `INSERT INTO feature_dependencies (id, source_fr_id, target_fr_id) VALUES (?, ?, ?)`,
      ['dep-2', 'feat-3', 'feat-1'],
    );
    await db.execute(
      `INSERT INTO feature_dependencies (id, source_fr_id, target_fr_id) VALUES (?, ?, ?)`,
      ['dep-3', 'feat-3', 'feat-2'],
    );

    const page = await listFeatureRequests(db, PROJECT_ID, {});
    const byFrId = new Map(page.items.map((f) => [f.fr_id, f]));

    expect(byFrId.get('FR-001')?.depends_on_fr_ids).toEqual([]);
    expect(byFrId.get('FR-002')?.depends_on_fr_ids).toEqual(['FR-001']);
    expect(new Set(byFrId.get('FR-003')?.depends_on_fr_ids)).toEqual(new Set(['FR-001', 'FR-002']));

    const detail = await getFeatureRequest(db, 'feat-3');
    expect(new Set(detail.feature.depends_on_fr_ids)).toEqual(new Set(['FR-001', 'FR-002']));
  });
});
