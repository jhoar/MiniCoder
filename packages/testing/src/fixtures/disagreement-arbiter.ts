import type { DbClient } from '@minicoder/core';
import { FeatureExecutionState } from '@minicoder/core';
import type { Fixture } from './types.js';

/**
 * One feature run (`FR-201`) at `under_review` with a tracked `pull_requests` row (PR #201),
 * `fix_attempt_count=0` — exercises Phase 11's disagreement-detection + Arbiter path: a
 * `MockReviewerAdapter('repeat_finding')` produces the identical blocking finding description on
 * every cycle, so the second `run-review` invocation (after a first cycle already wrote that
 * finding) must detect the repeat, open a `disagreement_records` row, and invoke
 * `MockArbiterAdapter`.
 */
export const disagreementArbiterFixture: Fixture = {
  name: 'disagreement-arbiter',
  description:
    'A feature run under review whose reviewer keeps raising the identical blocking finding ' +
    'across cycles, exercising Phase 11 disagreement detection and Arbiter resolution/escalation',

  async setup(db: DbClient, projectId = 'proj-disagreement-arbiter'): Promise<void> {
    const planId = `plan-${projectId}`;
    const frDbId = `fr-${projectId}-1`;
    const runId = `run-${projectId}-1`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Disagreement Arbiter Project', 'Fixture for disagreement-arbiter scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );
    await db.execute(
      `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
       VALUES (?, ?, 'minicoder-test', 'disagreement-arbiter-repo', 'minicoder-test/disagreement-arbiter-repo', 'main', 1, datetime('now'), datetime('now'))`,
      [`repo-${projectId}`, projectId],
    );
    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Disagreement Arbiter Plan', 'Plan for disagreement-arbiter testing', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-201', 'Feature FR-201', 'Fixture feature for FR-201', 'feature', 1, ?, 0, 1, datetime('now'), datetime('now'))`,
      [frDbId, planId, projectId, FeatureExecutionState.UNDER_REVIEW],
    );
    await db.execute(
      `INSERT OR IGNORE INTO acceptance_criteria (id, feature_request_id, description, order_index, version, created_at, updated_at)
       VALUES (?, ?, 'Acceptance criterion', 0, 1, datetime('now'), datetime('now'))`,
      [`ac-${frDbId}-1`, frDbId],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, fix_attempt_count, started_at, version, created_at, updated_at)
       VALUES (?, ?, 1, ?, 0, datetime('now'), 1, datetime('now'), datetime('now'))`,
      [runId, frDbId, FeatureExecutionState.UNDER_REVIEW],
    );
    await db.execute(
      `INSERT OR IGNORE INTO pull_requests (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state, ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
       VALUES (?, ?, 201, ?, 'main', 'sha-initial', 'open', 'none', 'pending', '[]', 0, 1, datetime('now'), datetime('now'))`,
      [`pr-${runId}`, runId, `minicoder/${runId}`],
    );
    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))
       ON CONFLICT (project_id) DO NOTHING`,
      [`ws-${projectId}`, projectId, runId],
    );
  },
};
