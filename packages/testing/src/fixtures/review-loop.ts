import type { DbClient } from '@minicoder/core';
import type { Fixture } from './types.js';

export const reviewLoopFixture: Fixture = {
  name: 'review-loop',
  description:
    'Feature at under_review state with 2 blocking findings and 3 review cycles recorded',

  async setup(db: DbClient, projectId = 'proj-review-loop'): Promise<void> {
    const planId = `plan-${projectId}`;
    const frId = `fr-${projectId}-1`;
    const featureRunId = `run-${projectId}-1`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Review Loop Project', 'Fixture for review-loop scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Review Loop Plan', 'Plan for review loop testing', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'API Endpoint', 'Implement the main API endpoint', 'feature', 1, 'under_review', 0, 1, datetime('now'), datetime('now'))`,
      [frId, planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
       VALUES (?, ?, 1, 'under_review', datetime('now'), 1, datetime('now'), datetime('now'))`,
      [featureRunId, frId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId, featureRunId],
    );

    // 2 blocking findings from previous review cycles
    for (let i = 1; i <= 2; i++) {
      await db.execute(
        `INSERT OR IGNORE INTO review_findings (id, feature_run_id, review_cycle, severity, category, description, resolved, version, created_at, updated_at)
         VALUES (?, ?, ?, 'blocking', 'correctness', ?, 0, 1, datetime('now'), datetime('now'))`,
        [
          `finding-${projectId}-${i}`,
          featureRunId,
          i,
          `Blocking finding ${i}: missing validation in handler`,
        ],
      );
    }
  },
};
