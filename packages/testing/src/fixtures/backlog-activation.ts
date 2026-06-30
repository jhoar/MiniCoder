import type { DbClient } from '@minicoder/core';
import type { Fixture } from './types.js';

export const backlogActivationFixture: Fixture = {
  name: 'backlog-activation',
  description: 'Project with approved plan and 3 features ready for activation',

  async setup(db: DbClient, projectId = 'proj-backlog'): Promise<void> {
    const specId = `spec-${projectId}`;
    const assessId = `assess-${projectId}`;
    const planId = `plan-${projectId}`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Backlog Activation Project', 'Fixture for backlog-activation scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO specification_inputs (id, project_id, content, content_type, version, created_at, updated_at)
       VALUES (?, ?, 'Build a task management system with projects and assignments.', 'text/plain', 1, datetime('now'), datetime('now'))`,
      [specId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO planning_readiness_assessments (id, project_id, specification_input_id, status, summary, version, created_at, updated_at)
       VALUES (?, ?, ?, 'sufficient', 'Requirements are clear', 1, datetime('now'), datetime('now'))`,
      [assessId, projectId, specId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, ?, 'approved', 'Task Management System', 'Projects, tasks, and assignments', 1, datetime('now'), datetime('now'))`,
      [planId, projectId, assessId],
    );

    const features = [
      { frId: 'FR-001', title: 'Project CRUD' },
      { frId: 'FR-002', title: 'Task CRUD' },
      { frId: 'FR-003', title: 'Assignment System' },
    ];

    for (let i = 0; i < features.length; i++) {
      const f = features[i]!;
      await db.execute(
        `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'feature', 1, 'approved_pending_execution', ?, 1, datetime('now'), datetime('now'))`,
        [`fr-${projectId}-${i + 1}`, planId, projectId, f.frId, f.title, `Implement ${f.title}`, i],
      );
    }

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId],
    );
  },
};
