import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import type { DbClient } from '@minicoder/core';
import { listPlanSections } from './planning.js';

/**
 * Previously there was no way to read a plan's generated `plan_sections` content short of a raw
 * SQL query or `minicoder plan export` (which renders a whole new artifact_exports row). Proves
 * `listPlanSections()` returns sections ordered by `order_index`, scoped to the requested plan
 * only — a second, unrelated plan's sections must never leak in.
 */

const PROJECT_ID = 'proj-plan-sections';

async function seedPlan(db: DbClient, planId: string): Promise<void> {
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, state, title, version, created_at, updated_at)
     VALUES (?, ?, 'draft', 'Test Plan', 1, datetime('now'), datetime('now'))`,
    [planId, PROJECT_ID],
  );
}

describe('listPlanSections', () => {
  it('returns sections ordered by order_index, scoped to the requested plan only', async () => {
    const db = createTestDb();
    await db.execute(`INSERT INTO projects (id, name) VALUES (?, ?)`, [PROJECT_ID, 'Test']);
    await seedPlan(db, 'plan-1');
    await seedPlan(db, 'plan-2');

    await db.execute(
      `INSERT INTO plan_sections (id, plan_id, title, content, order_index, version, created_at, updated_at)
       VALUES (?, ?, 'Overview', 'Build CRUD endpoints.', 1, 1, datetime('now'), datetime('now'))`,
      ['section-2', 'plan-1'],
    );
    await db.execute(
      `INSERT INTO plan_sections (id, plan_id, title, content, order_index, version, created_at, updated_at)
       VALUES (?, ?, 'Data Model', 'Define entities.', 0, 1, datetime('now'), datetime('now'))`,
      ['section-1', 'plan-1'],
    );
    // A section for the OTHER plan — must never appear in plan-1's list.
    await db.execute(
      `INSERT INTO plan_sections (id, plan_id, title, content, order_index, version, created_at, updated_at)
       VALUES (?, ?, 'Unrelated', 'Unrelated content.', 0, 1, datetime('now'), datetime('now'))`,
      ['section-3', 'plan-2'],
    );

    const sections = await listPlanSections(db, 'plan-1');

    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.title)).toEqual(['Data Model', 'Overview']);
    expect(sections[0]).toMatchObject({ title: 'Data Model', content: 'Define entities.' });
  });
});
