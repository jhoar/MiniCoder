import type { DbClient } from '@minicoder/core';
import type { Fixture } from './types.js';

export const planningBasicFixture: Fixture = {
  name: 'planning-basic',
  description: 'Project with specification and assessment (sufficient), plan in draft state',

  async setup(db: DbClient, projectId = 'proj-planning-basic'): Promise<void> {
    const specId = `spec-${projectId}`;
    const assessId = `assess-${projectId}`;
    const planId = `plan-${projectId}`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Planning Basic Project', 'Test fixture for planning-basic scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO specification_inputs (id, project_id, content, content_type, version, created_at, updated_at)
       VALUES (?, ?, 'Build a user authentication system with JWT tokens and refresh token rotation.', 'text/plain', 1, datetime('now'), datetime('now'))`,
      [specId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO planning_readiness_assessments (id, project_id, specification_input_id, status, summary, version, created_at, updated_at)
       VALUES (?, ?, ?, 'sufficient', 'Specification is clear and complete', 1, datetime('now'), datetime('now'))`,
      [assessId, projectId, specId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', 'Auth System Implementation', 'JWT authentication with refresh tokens', 1, datetime('now'), datetime('now'))`,
      [planId, projectId, assessId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId],
    );
  },
};
