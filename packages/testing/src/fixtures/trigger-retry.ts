import type { DbClient } from '@minicoder/core';
import type { Fixture } from './types.js';

export const triggerRetryFixture: Fixture = {
  name: 'trigger-retry',
  description: 'Feature at selected state with a failed triggerdev_runs row, ready for retry',

  async setup(db: DbClient, projectId = 'proj-trigger-retry'): Promise<void> {
    const planId = `plan-${projectId}`;
    const frId = `fr-${projectId}-1`;
    const featureRunId = `run-${projectId}-1`;
    const triggerdevRunId = `tdrun-${projectId}-1`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Trigger Retry Project', 'Fixture for trigger-retry scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Trigger Retry Plan', 'Plan for trigger retry testing', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'Retryable Feature', 'Feature to test idempotent retry', 'feature', 1, 'selected', 0, 1, datetime('now'), datetime('now'))`,
      [frId, planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
       VALUES (?, ?, 1, 'selected', datetime('now'), 1, datetime('now'), datetime('now'))`,
      [featureRunId, frId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId, featureRunId],
    );

    // A failed triggerdev run for the start-next-feature task
    await db.execute(
      `INSERT OR IGNORE INTO triggerdev_runs
         (id, triggerdev_run_id, triggerdev_task_id, triggerdev_status, project_id,
          linked_feature_run_id, last_seen_at, version, created_at, updated_at)
       VALUES (?, ?, 'start-next-feature', 'failed', ?, ?, datetime('now'), 1, datetime('now'), datetime('now'))`,
      [triggerdevRunId, `tdv2-${projectId}-run-001`, projectId, featureRunId],
    );
  },
};
