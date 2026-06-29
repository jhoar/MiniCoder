import type { DbClient } from '@minicoder/core';
import type { Fixture } from './types.js';

export const mergeGateFixture: Fixture = {
  name: 'merge-gate',
  description: 'Feature at merge_ready state with an approved merge gate evaluation',

  async setup(db: DbClient, projectId = 'proj-merge-gate'): Promise<void> {
    const planId = `plan-${projectId}`;
    const frId = `fr-${projectId}-1`;
    const featureRunId = `run-${projectId}-1`;
    const evalId = `eval-${projectId}-1`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Merge Gate Project', 'Fixture for merge-gate scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Merge Gate Plan', 'Plan for merge gate testing', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'Core Feature', 'The core feature under test', 'feature', 1, 'merge_ready', 0, 1, datetime('now'), datetime('now'))`,
      [frId, planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
       VALUES (?, ?, 1, 'merge_ready', datetime('now'), 1, datetime('now'), datetime('now'))`,
      [featureRunId, frId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId, featureRunId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO merge_gate_evaluations
         (id, feature_run_id, ci_status, review_status, unresolved_blocking_findings,
          budget_status, human_approval_required, branch_protection_ok, final_decision, version, created_at, updated_at)
       VALUES (?, ?, 'passed', 'approved', 0, 'ok', 0, 1, 'approved', 1, datetime('now'), datetime('now'))`,
      [evalId, featureRunId],
    );
  },
};
