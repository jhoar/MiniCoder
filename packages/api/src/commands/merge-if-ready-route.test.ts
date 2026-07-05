import { describe, it, expect } from 'vitest';
import type { DbClient, GitHubClient } from '@minicoder/core';
import { buildTestApp, TEST_APPROVER_KEY, seedProjectWithWorkflowState } from '../test-helpers.js';

const fakeGithubClientFactory = async (): Promise<GitHubClient> =>
  ({
    createBranch: async () => ({ branchName: 'unused', sha: 'unused' }),
    createPullRequest: async () => ({ prNumber: 1, branchName: 'unused' }),
    getPullRequest: async () => null,
    publishStatusCheck: async () => undefined,
    getRemainingRateLimit: async () => ({ remaining: 5000, resetAt: new Date().toISOString() }),
    mergePullRequest: async () => ({ mergeSha: 'unused' }),
  }) as unknown as GitHubClient;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function seedFeatureRun(db: DbClient, projectId: string): Promise<{ featureRunId: string }> {
  const now = new Date().toISOString();
  const planId = generateId();
  const featureRequestId = generateId();
  const featureRunId = generateId();
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'approved', 'Test plan', NULL, 1, ?, ?)`,
    [planId, projectId, now, now],
  );
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Test feature', 'desc', 'feature', TRUE, 'approved_pending_execution', 0, 1, ?, ?)`,
    [featureRequestId, planId, projectId, now, now],
  );
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, lock_id, started_at, ended_at, outcome, version, created_at, updated_at)
     VALUES (?, ?, 1, 'approved_by_policy', NULL, ?, NULL, NULL, 1, ?, ?)`,
    [featureRunId, featureRequestId, now, now, now],
  );
  return { featureRunId };
}

describe('POST /commands/merge-if-ready', () => {
  it('requires featureRunId and projectId in the body', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/commands/merge-if-ready',
      headers: {
        authorization: `Bearer ${TEST_APPROVER_KEY}`,
        'idempotency-key': 'merge-1',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the feature run has no repository/pull-request tracked', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { featureRunId } = await seedFeatureRun(db, projectId);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/merge-if-ready',
      headers: {
        authorization: `Bearer ${TEST_APPROVER_KEY}`,
        'idempotency-key': 'merge-2',
      },
      payload: { featureRunId, projectId },
    });
    // No `pull_requests`/`repositories` row exists — the route's own pre-check throws NotFoundError
    // before ever reaching MergeIfReadyHandler's gate re-evaluation.
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 with structured reasons when the merge gate rejects (not the active feature run)', async () => {
    const { app, db } = await buildTestApp({ githubClientFactory: fakeGithubClientFactory });
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { featureRunId } = await seedFeatureRun(db, projectId);
    const now = new Date().toISOString();
    const repoId = generateId();
    await db.execute(
      `INSERT INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
       VALUES (?, ?, 'acme', 'widgets', 'acme/widgets', 'main', 1, ?, ?)`,
      [repoId, projectId, now, now],
    );
    await db.execute(
      `INSERT INTO pull_requests (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state, ci_status, mergeable, blocking_labels, conversations_resolved, version, created_at, updated_at)
       VALUES (?, ?, 1, 'minicoder/FR-001', 'main', 'abc123', 'open', 'approved', 'passed', TRUE, '[]', FALSE, 1, ?, ?)`,
      [generateId(), featureRunId, now, now],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/commands/merge-if-ready',
      headers: {
        authorization: `Bearer ${TEST_APPROVER_KEY}`,
        'idempotency-key': 'merge-3',
      },
      payload: { featureRunId, projectId },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.merged).toBe(false);
    expect(body.reasons.join(' ')).toContain("not the project's active feature run");
  });

  it('succeeds end-to-end for an approver actor and replays the cached response on retry (findings 1 & 4)', async () => {
    const { app, db } = await buildTestApp({ githubClientFactory: fakeGithubClientFactory });
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { featureRunId } = await seedFeatureRun(db, projectId);
    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
       VALUES (?, ?, 'acme', 'widgets', 'acme/widgets', 'main', 1, ?, ?)`,
      [generateId(), projectId, now, now],
    );
    await db.execute(
      `INSERT INTO pull_requests (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state, ci_status, mergeable, blocking_labels, conversations_resolved, version, created_at, updated_at)
       VALUES (?, ?, 1, 'minicoder/FR-001', 'main', 'abc123', 'open', 'approved', 'passed', TRUE, '[]', FALSE, 1, ?, ?)`,
      [generateId(), featureRunId, now, now],
    );
    // The feature run must be the project's active feature for the gate to pass.
    await db.execute(`UPDATE workflow_states SET active_feature_run_id = ? WHERE project_id = ?`, [
      featureRunId,
      projectId,
    ]);

    const first = await app.inject({
      method: 'POST',
      url: '/commands/merge-if-ready',
      headers: {
        authorization: `Bearer ${TEST_APPROVER_KEY}`,
        'idempotency-key': 'merge-happy-path',
      },
      payload: { featureRunId, projectId },
    });

    // Prior to the fix, this failed with a 403 authorization-error because the route built its
    // internal "system" actor with the approver's own role instead of admin.
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);
    expect(firstBody).toMatchObject({ merged: true, mergeSha: 'unused' });

    const featureRunRow = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(featureRunRow[0]?.current_execution_state).toBe('merged');

    // Retrying with the same Idempotency-Key must replay the exact original response, not fail
    // because the run has since moved past merge_ready to a terminal merged state.
    const second = await app.inject({
      method: 'POST',
      url: '/commands/merge-if-ready',
      headers: {
        authorization: `Bearer ${TEST_APPROVER_KEY}`,
        'idempotency-key': 'merge-happy-path',
      },
      payload: { featureRunId, projectId },
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body)).toEqual(firstBody);
  });
});
