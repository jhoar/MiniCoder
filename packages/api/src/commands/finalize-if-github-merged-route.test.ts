import { describe, it, expect } from 'vitest';
import type { DbClient, ScmClient } from '@minicoder/core';
import {
  buildTestApp,
  TEST_OPERATOR_KEY,
  TEST_VIEWER_KEY,
  seedProjectWithWorkflowState,
} from '../test-helpers.js';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function seedFeatureRun(
  db: DbClient,
  projectId: string,
  state: string,
): Promise<{ featureRunId: string }> {
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
     VALUES (?, ?, ?, 'FR-001', 'Test feature', 'desc', 'feature', TRUE, ?, 0, 1, ?, ?)`,
    [featureRequestId, planId, projectId, state, now, now],
  );
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, lock_id, started_at, ended_at, outcome, version, created_at, updated_at)
     VALUES (?, ?, 1, ?, NULL, ?, NULL, NULL, 1, ?, ?)`,
    [featureRunId, featureRequestId, state, now, now, now],
  );
  return { featureRunId };
}

async function seedRepoAndPr(db: DbClient, featureRunId: string, projectId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
     VALUES (?, ?, 'acme', 'widgets', 'acme/widgets', 'main', 1, ?, ?)`,
    [generateId(), projectId, now, now],
  );
  await db.execute(
    `INSERT INTO pull_requests (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state, ci_status, mergeable, blocking_labels, conversations_resolved, version, created_at, updated_at)
     VALUES (?, ?, 9, 'minicoder/FR-001', 'main', 'abc123', 'open', 'approved', 'passed', TRUE, '[]', FALSE, 1, ?, ?)`,
    [generateId(), featureRunId, now, now],
  );
}

function githubClientConfirmingMerged(): ScmClient {
  return {
    async createBranch() {
      return { branchName: 'unused', sha: 'unused' };
    },
    async createPullRequest() {
      return { prNumber: 9, branchName: 'unused' };
    },
    async mergePullRequest() {
      throw new Error('not used');
    },
    async getPullRequest() {
      return {
        prNumber: 9,
        branchName: 'minicoder/FR-001',
        baseBranch: 'main',
        headSha: 'abc123',
        state: 'merged',
        reviewState: 'approved' as never,
        ciStatus: 'passed' as never,
        mergeable: null,
        blockingLabels: [],
        conversationsResolved: false,
        mergedAt: new Date().toISOString(),
        mergeSha: 'merged-sha-123',
        closedAt: new Date().toISOString(),
      };
    },
    async publishStatusCheck() {},
    async getRemainingRateLimit() {
      return 5000;
    },
    async getPullRequestDiff() {
      return '';
    },
    async listPullRequestsForBranch() {
      return [];
    },
  };
}

function githubClientNotMerged(): ScmClient {
  return {
    async createBranch() {
      return { branchName: 'unused', sha: 'unused' };
    },
    async createPullRequest() {
      return { prNumber: 9, branchName: 'unused' };
    },
    async mergePullRequest() {
      throw new Error('not used');
    },
    async getPullRequest() {
      return {
        prNumber: 9,
        branchName: 'minicoder/FR-001',
        baseBranch: 'main',
        headSha: 'abc123',
        state: 'open',
        reviewState: 'approved' as never,
        ciStatus: 'passed' as never,
        mergeable: true,
        blockingLabels: [],
        conversationsResolved: false,
        mergedAt: null,
        mergeSha: null,
        closedAt: null,
      };
    },
    async publishStatusCheck() {},
    async getRemainingRateLimit() {
      return 5000;
    },
    async getPullRequestDiff() {
      return '';
    },
    async listPullRequestsForBranch() {
      return [];
    },
  };
}

describe('POST /commands/finalize-if-github-merged', () => {
  it('requires operator role or higher', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { featureRunId } = await seedFeatureRun(db, projectId, 'merge_ready');
    const res = await app.inject({
      method: 'POST',
      url: '/commands/finalize-if-github-merged',
      headers: { authorization: `Bearer ${TEST_VIEWER_KEY}` },
      payload: { featureRunId, projectId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for an unknown feature run', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const res = await app.inject({
      method: 'POST',
      url: '/commands/finalize-if-github-merged',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { featureRunId: 'nope', projectId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns alreadyRecorded:true without calling GitHub when the run is already merged', async () => {
    const { app, db } = await buildTestApp({
      githubClientFactory: async () => githubClientNotMerged(),
    });
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { featureRunId } = await seedFeatureRun(db, projectId, 'merged');
    const res = await app.inject({
      method: 'POST',
      url: '/commands/finalize-if-github-merged',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { featureRunId, projectId },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ alreadyRecorded: true });
  });

  it('rejects a run that is not at merge_ready or merged', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { featureRunId } = await seedFeatureRun(db, projectId, 'under_review');
    const res = await app.inject({
      method: 'POST',
      url: '/commands/finalize-if-github-merged',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { featureRunId, projectId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to record when GitHub does not confirm the PR as merged', async () => {
    const { app, db } = await buildTestApp({
      githubClientFactory: async () => githubClientNotMerged(),
    });
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { featureRunId } = await seedFeatureRun(db, projectId, 'merge_ready');
    await seedRepoAndPr(db, featureRunId, projectId);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/finalize-if-github-merged',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { featureRunId, projectId },
    });
    expect(res.statusCode).toBe(400);

    const rows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(rows[0]?.current_execution_state).toBe('merge_ready');
  });

  it('records the merge after re-verifying with GitHub', async () => {
    const { app, db } = await buildTestApp({
      githubClientFactory: async () => githubClientConfirmingMerged(),
    });
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { featureRunId } = await seedFeatureRun(db, projectId, 'merge_ready');
    await seedRepoAndPr(db, featureRunId, projectId);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/finalize-if-github-merged',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { featureRunId, projectId },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.merged).toBe(true);
    expect(body.mergeSha).toBe('merged-sha-123');

    const rows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(rows[0]?.current_execution_state).toBe('merged');
  });
});
