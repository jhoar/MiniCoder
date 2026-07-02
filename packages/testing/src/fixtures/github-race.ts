import type { DbClient } from '@minicoder/core';
import { FeatureExecutionState } from '@minicoder/core';
import type { Fixture } from './types.js';

export const GITHUB_RACE_PR_NUMBER = 42;

export const githubRaceFixture: Fixture = {
  name: 'github-race',
  description:
    'Feature at ci_running with a tracked pull_requests row, simulating a GitHub PR-closed race condition during CI',

  async setup(db: DbClient, projectId = 'proj-github-race'): Promise<void> {
    const planId = `plan-${projectId}`;
    const frId = `fr-${projectId}-1`;
    const featureRunId = `run-${projectId}-1`;
    const pullRequestId = `pr-${projectId}-1`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'GitHub Race Project', 'Fixture for github-race scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
       VALUES (?, ?, 'minicoder-test', 'race-repo', 'minicoder-test/race-repo', 'main', 1, datetime('now'), datetime('now'))`,
      [`repo-${projectId}`, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'GitHub Race Plan', 'Plan for github race testing', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'Race Feature', 'Feature with concurrent CI and PR close', 'feature', 1, ?, 0, 1, datetime('now'), datetime('now'))`,
      [frId, planId, projectId, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
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

    // Tracked pull request row: PR is open and CI is running at fixture setup time. The scenario
    // then simulates the race by closing the PR (without merging) on the MockGitHubProvider while
    // the DB record still says ci_running.
    await db.execute(
      `INSERT OR IGNORE INTO pull_requests
         (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
          ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
       VALUES (?, ?, ?, 'minicoder/FR-001', 'main', 'abc0000000', 'open', 'none', 'running', '[]', 0, 1, datetime('now'), datetime('now'))`,
      [pullRequestId, featureRunId, GITHUB_RACE_PR_NUMBER],
    );
  },
};
