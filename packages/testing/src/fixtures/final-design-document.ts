import type { DbClient } from '@minicoder/core';
import type { Fixture } from './types.js';

export const finalDesignDocumentFixture: Fixture = {
  name: 'final-design-document',
  description:
    'Project at implementation_complete with pending artifact_exports and a design_documents row',

  async setup(db: DbClient, projectId = 'proj-final-doc'): Promise<void> {
    const planId = `plan-${projectId}`;
    const designDocId = `dd-${projectId}-1`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Final Doc Project', 'Fixture for final-design-document scenario', 'implementation_complete', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Final Doc Plan', 'Completed implementation plan', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId],
    );

    // Pending artifact exports for plan and backlog
    await db.execute(
      `INSERT OR IGNORE INTO artifact_exports (id, project_id, artifact_type, state, format, version, created_at, updated_at)
       VALUES (?, ?, 'plan', 'pending', 'markdown', 1, datetime('now'), datetime('now'))`,
      [`ae-${projectId}-plan`, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO artifact_exports (id, project_id, artifact_type, state, format, version, created_at, updated_at)
       VALUES (?, ?, 'backlog', 'pending', 'markdown', 1, datetime('now'), datetime('now'))`,
      [`ae-${projectId}-backlog`, projectId],
    );

    // Design document in draft state
    await db.execute(
      `INSERT OR IGNORE INTO design_documents (id, project_id, state, version, created_at, updated_at)
       VALUES (?, ?, 'draft', 1, datetime('now'), datetime('now'))`,
      [designDocId, projectId],
    );
  },
};
