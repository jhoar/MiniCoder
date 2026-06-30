import type { DbClient } from '@minicoder/core';
import type { Fixture } from './types.js';

export const githubRaceFixture: Fixture = {
  name: 'github-race',
  description:
    'Feature at ci_running state with a pr.closed inbox_events row, simulating a GitHub race condition',

  async setup(db: DbClient, projectId = 'proj-github-race'): Promise<void> {
    const planId = `plan-${projectId}`;
    const frId = `fr-${projectId}-1`;
    const featureRunId = `run-${projectId}-1`;
    const prNumber = 42;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'GitHub Race Project', 'Fixture for github-race scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'GitHub Race Plan', 'Plan for github race testing', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'Race Feature', 'Feature with concurrent CI and PR close', 'feature', 1, 'ci_running', 0, 1, datetime('now'), datetime('now'))`,
      [frId, planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
       VALUES (?, ?, 1, 'ci_running', datetime('now'), 1, datetime('now'), datetime('now'))`,
      [featureRunId, frId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId, featureRunId],
    );

    // Inbox event: PR closed while CI was still running
    const payload = JSON.stringify({
      projectId,
      featureRunId,
      prNumber,
      action: 'closed',
      merged: false,
    });

    await db.execute(
      `INSERT OR IGNORE INTO inbox_events
         (id, dedup_key, source, event_type, payload, payload_schema_version,
          status, version, created_at, updated_at)
       VALUES (?, ?, 'github', 'pr.closed', ?, '1.0', 'pending', 1, datetime('now'), datetime('now'))`,
      [`inbox-${projectId}-pr-closed`, `github:pr.closed:${projectId}:${prNumber}`, payload],
    );
  },
};
