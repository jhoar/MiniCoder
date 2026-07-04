import type { DbClient } from '@minicoder/core';
import { FeatureExecutionState } from '@minicoder/core';
import type { Fixture } from './types.js';

export const coderAdapterRunFixture: Fixture = {
  name: 'coder-adapter-run',
  description:
    'Two feature runs already at `coding` (fr-1 for the happy path, fr-2 reserved for an adapter-failure sub-scenario), a linked repository row, and workflow_states pointing fr-1 as the active run',

  async setup(db: DbClient, projectId = 'proj-coder-adapter-run'): Promise<void> {
    const planId = `plan-${projectId}`;
    const fr1Id = `fr-${projectId}-1`;
    const fr2Id = `fr-${projectId}-2`;
    const run1Id = `run-${projectId}-1`;
    const run2Id = `run-${projectId}-2`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Coder Adapter Run Project', 'Fixture for coder-adapter-run scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
       VALUES (?, ?, 'minicoder-test', 'coder-adapter-run-repo', 'minicoder-test/coder-adapter-run-repo', 'main', 1, datetime('now'), datetime('now'))`,
      [`repo-${projectId}`, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Coder Adapter Run Plan', 'Plan for coder-adapter-run testing', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'Add widget', 'Feature for the coder-adapter-run happy path', 'feature', 1, ?, 0, 1, datetime('now'), datetime('now'))`,
      [fr1Id, planId, projectId, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
    );
    await db.execute(
      `INSERT OR IGNORE INTO acceptance_criteria (id, feature_request_id, description, order_index, version, created_at, updated_at)
       VALUES (?, ?, 'The widget renders', 0, 1, datetime('now'), datetime('now'))`,
      [`ac-${fr1Id}-1`, fr1Id],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
      [run1Id, fr1Id, FeatureExecutionState.CODING],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-002', 'Add gadget', 'Feature reserved for the coder-adapter-failure sub-scenario', 'feature', 1, ?, 0, 1, datetime('now'), datetime('now'))`,
      [fr2Id, planId, projectId, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
    );
    await db.execute(
      `INSERT OR IGNORE INTO acceptance_criteria (id, feature_request_id, description, order_index, version, created_at, updated_at)
       VALUES (?, ?, 'The gadget renders', 0, 1, datetime('now'), datetime('now'))`,
      [`ac-${fr2Id}-1`, fr2Id],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
      [run2Id, fr2Id, FeatureExecutionState.CODING],
    );

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId, run1Id],
    );
  },
};
