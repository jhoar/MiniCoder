import type { DbClient } from '@minicoder/core';
import { FeatureExecutionState } from '@minicoder/core';
import type { Fixture } from './types.js';

export const executionOrchestratorFixture: Fixture = {
  name: 'execution-orchestrator',
  description:
    'Two feature requests (fr-2 depends on fr-1) both approved_pending_execution, an active budget_policies row scoped to fr-1, and automation running with no active feature run',

  async setup(db: DbClient, projectId = 'proj-execution-orchestrator'): Promise<void> {
    const planId = `plan-${projectId}`;
    const fr1Id = `fr-${projectId}-1`;
    const fr2Id = `fr-${projectId}-2`;
    const run1Id = `run-${projectId}-1`;
    const run2Id = `run-${projectId}-2`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Execution Orchestrator Project', 'Fixture for execution-orchestrator scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Execution Orchestrator Plan', 'Plan for execution orchestrator testing', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'First Feature', 'Feature with no dependencies', 'feature', 1, ?, 0, 1, datetime('now', '-2 seconds'), datetime('now'))`,
      [fr1Id, planId, projectId, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-002', 'Second Feature', 'Feature depending on FR-001', 'feature', 1, ?, 0, 1, datetime('now', '-1 seconds'), datetime('now'))`,
      [fr2Id, planId, projectId, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_dependencies (id, source_fr_id, target_fr_id, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
      [`dep-${projectId}`, fr2Id, fr1Id],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
      [run1Id, fr1Id, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
      [run2Id, fr2Id, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
    );

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId],
    );

    // Feature-scoped budget policy tied to FR-001 — soft/hard limits crossed by the scenario
    // inserting synthetic cost_records against fr1Id.
    await db.execute(
      `INSERT OR IGNORE INTO budget_policies
         (id, project_id, scope, feature_request_id, currency, soft_limit, hard_limit, window_days, is_active, version, created_at, updated_at)
       VALUES (?, ?, 'feature', ?, 'USD', 50, 100, NULL, 1, 1, datetime('now'), datetime('now'))`,
      [`budget-${projectId}`, projectId, fr1Id],
    );
  },
};
