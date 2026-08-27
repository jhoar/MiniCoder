import { describe, it, expect } from 'vitest';
import type { DbClient, ScmClient } from '@minicoder/core';
import { FeatureExecutionState } from '@minicoder/core';
import { createTestDb, insertTestProject } from '../test-helpers.js';
import { runImpl } from './run-merge-gate.js';

const PROJECT_ID = 'proj-run-merge-gate-001';

interface FixtureIds {
  featureRunId: string;
}

async function seedFeatureRun(
  db: DbClient,
  opts: {
    hasBlockingFinding?: boolean;
    notActive?: boolean;
    prClosed?: boolean;
    wrongBaseBranch?: boolean;
  } = {},
): Promise<FixtureIds> {
  const planId = `plan-${PROJECT_ID}`;
  const frId = `fr-${PROJECT_ID}-1`;
  const featureRunId = `run-${PROJECT_ID}-1`;

  await db.execute(
    `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
     VALUES (?, ?, 'minicoder-test', 'run-merge-gate-repo', 'minicoder-test/run-merge-gate-repo', 'main', 1, datetime('now'), datetime('now'))`,
    [`repo-${PROJECT_ID}`, PROJECT_ID],
  );
  await db.execute(
    `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
    [planId, PROJECT_ID],
  );
  await db.execute(
    `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Add widget', 'Description', 'feature', 1, 'under_review', 0, 1, datetime('now'), datetime('now'))`,
    [frId, planId, PROJECT_ID],
  );
  await db.execute(
    `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
     VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
    [featureRunId, frId, FeatureExecutionState.UNDER_REVIEW],
  );
  await db.execute(
    `INSERT OR IGNORE INTO pull_requests
       (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
        ci_status, mergeable, blocking_labels, conversations_resolved, version, created_at, updated_at)
     VALUES (?, ?, 9, 'minicoder/FR-001', ?, 'headsha1', ?, 'approved', 'passed', 1, '[]', 0, 1, datetime('now'), datetime('now'))`,
    [
      `pr-${featureRunId}`,
      featureRunId,
      opts.wrongBaseBranch ? 'develop' : 'main',
      opts.prClosed ? 'closed' : 'open',
    ],
  );
  await db.execute(
    `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))`,
    [`ws-${PROJECT_ID}`, PROJECT_ID, opts.notActive ? 'some-other-run' : featureRunId],
  );
  if (opts.hasBlockingFinding) {
    await db.execute(
      `INSERT OR IGNORE INTO review_findings
         (id, feature_run_id, review_cycle, severity, description, resolved, version, created_at, updated_at)
       VALUES (?, ?, 1, 'blocking', 'Unresolved blocking finding', FALSE, 1, datetime('now'), datetime('now'))`,
      [`finding-${featureRunId}`, featureRunId],
    );
  }

  return { featureRunId };
}

function fakeGithubClient(): ScmClient & {
  publishedChecks: Array<{ state: string; description?: string }>;
} {
  const publishedChecks: Array<{ state: string; description?: string }> = [];
  return {
    publishedChecks,
    async createBranch() {
      throw new Error('not used in this test');
    },
    async createPullRequest() {
      throw new Error('not used in this test');
    },
    async mergePullRequest(): Promise<{ mergeSha: string }> {
      throw new Error('not used in this test');
    },
    async getPullRequest() {
      return null;
    },
    async publishStatusCheck(opts) {
      publishedChecks.push({ state: opts.state, description: opts.description });
    },
    async getRemainingRateLimit() {
      return 5000;
    },
    async getPullRequestDiff() {
      return 'diff --git a/x b/x\n';
    },
    async listPullRequestsForBranch() {
      return [];
    },
  };
}

describe('run-merge-gate', () => {
  it('approves a clean under_review feature run and publishes a success status check', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedFeatureRun(db);
    const client = fakeGithubClient();

    const result = await runImpl(
      {
        projectId: PROJECT_ID,
        correlationId: 'corr-1',
        idempotencyKey: 'idem-1',
        featureRunId,
      },
      db,
      { resolveScmClient: async () => client },
    );

    expect(result.evaluated).toBe(true);
    expect(result.approved).toBe(true);

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.APPROVED_BY_POLICY);

    expect(client.publishedChecks).toHaveLength(1);
    expect(client.publishedChecks[0]?.state).toBe('success');
  });

  it('rejects a feature run with an unresolved blocking finding and publishes a failure status check', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedFeatureRun(db, { hasBlockingFinding: true });
    const client = fakeGithubClient();

    const result = await runImpl(
      {
        projectId: PROJECT_ID,
        correlationId: 'corr-2',
        idempotencyKey: 'idem-2',
        featureRunId,
      },
      db,
      { resolveScmClient: async () => client },
    );

    expect(result.evaluated).toBe(true);
    expect(result.approved).toBe(false);
    expect(result.reasons.join(' ')).toContain('unresolved blocking');

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.UNDER_REVIEW);

    expect(client.publishedChecks).toHaveLength(1);
    expect(client.publishedChecks[0]?.state).toBe('failure');
  });

  it('is a no-op for a feature run not at under_review', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedFeatureRun(db);
    await db.execute(`UPDATE feature_runs SET current_execution_state = 'coding' WHERE id = ?`, [
      featureRunId,
    ]);
    const client = fakeGithubClient();

    const result = await runImpl(
      { projectId: PROJECT_ID, correlationId: 'corr-3', idempotencyKey: 'idem-3', featureRunId },
      db,
      { resolveScmClient: async () => client },
    );

    expect(result.evaluated).toBe(false);
    expect(client.publishedChecks).toHaveLength(0);
  });

  it('does not publish a status check when the PR has no tracked head SHA', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedFeatureRun(db);
    await db.execute(`UPDATE pull_requests SET head_sha = NULL WHERE feature_run_id = ?`, [
      featureRunId,
    ]);
    const client = fakeGithubClient();

    const result = await runImpl(
      { projectId: PROJECT_ID, correlationId: 'corr-4', idempotencyKey: 'idem-4', featureRunId },
      db,
      { resolveScmClient: async () => client },
    );

    expect(result.approved).toBe(true);
    expect(client.publishedChecks).toHaveLength(0);
  });

  it('re-approves a feature run that cycled back to under_review at a later version (code-review regression: idempotency key must be version-scoped)', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedFeatureRun(db);
    const client = fakeGithubClient();

    const firstResult = await runImpl(
      { projectId: PROJECT_ID, correlationId: 'corr-5a', idempotencyKey: 'idem-5a', featureRunId },
      db,
      { resolveScmClient: async () => client },
    );
    expect(firstResult.approved).toBe(true);

    // Simulate a full merge_ready -> merge_failed -> under_review cycle having happened
    // elsewhere: the row is back at under_review, at a materially later version. A key scoped
    // only to featureRunId (the pre-fix behavior) would replay the first call's cached
    // CommandResult here without ever re-running the state-transition UPDATE, leaving this row
    // stranded at under_review while falsely reporting success.
    await db.execute(
      `UPDATE feature_runs SET current_execution_state = 'under_review', version = 9 WHERE id = ?`,
      [featureRunId],
    );

    const secondResult = await runImpl(
      { projectId: PROJECT_ID, correlationId: 'corr-5b', idempotencyKey: 'idem-5b', featureRunId },
      db,
      { resolveScmClient: async () => client },
    );
    expect(secondResult.approved).toBe(true);

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.APPROVED_BY_POLICY);
  });

  it("rejects a feature run that is not the project's active feature run (code-review re-review fix)", async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedFeatureRun(db, { notActive: true });
    const client = fakeGithubClient();

    const result = await runImpl(
      { projectId: PROJECT_ID, correlationId: 'corr-6', idempotencyKey: 'idem-6', featureRunId },
      db,
      { resolveScmClient: async () => client },
    );

    expect(result.approved).toBe(false);
    expect(result.reasons.join(' ')).toContain('active feature run');
  });

  it('rejects a feature run whose PR is closed (code-review re-review fix)', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedFeatureRun(db, { prClosed: true });
    const client = fakeGithubClient();

    const result = await runImpl(
      { projectId: PROJECT_ID, correlationId: 'corr-7', idempotencyKey: 'idem-7', featureRunId },
      db,
      { resolveScmClient: async () => client },
    );

    expect(result.approved).toBe(false);
    expect(result.reasons.join(' ')).toContain("not 'open'");
  });

  it('rejects a feature run whose PR targets the wrong base branch (code-review re-review fix)', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedFeatureRun(db, { wrongBaseBranch: true });
    const client = fakeGithubClient();

    const result = await runImpl(
      { projectId: PROJECT_ID, correlationId: 'corr-8', idempotencyKey: 'idem-8', featureRunId },
      db,
      { resolveScmClient: async () => client },
    );

    expect(result.approved).toBe(false);
    expect(result.reasons.join(' ')).toContain('base branch');
  });
});

/**
 * Stage 6 write-pipeline follow-up (docs/06 §Phase 18): before this fix, `runImpl` always
 * resolved a `GithubClientFactory` with no provider argument, so a GitLab/Gitea-provider
 * project's status-check publication always went through `OctokitGitHubClient`. Asserts
 * `resolveScmClient` now receives the repository row's own `provider`/`base_url`.
 */
describe('run-merge-gate (Stage 6: provider-aware client resolution)', () => {
  it("resolves the ScmClient using the repository row's own provider and base_url for a GitLab-provider project", async () => {
    const db = createTestDb();
    const projectId = 'proj-run-merge-gate-provider-gitlab';
    insertTestProject(db, projectId);

    const planId = `plan-${projectId}`;
    const frId = `fr-${projectId}-1`;
    const featureRunId = `run-${projectId}-1`;
    await db.execute(
      `INSERT INTO repositories (id, project_id, owner, name, full_name, default_branch, provider, base_url, version, created_at, updated_at)
       VALUES (?, ?, 'acme', 'widgets', 'acme/widgets', 'main', 'gitlab', 'https://gitlab.example.test', 1, datetime('now'), datetime('now'))`,
      [`repo-${projectId}`, projectId],
    );
    await db.execute(
      `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );
    await db.execute(
      `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'Add widget', 'Description', 'feature', 1, 'under_review', 0, 1, datetime('now'), datetime('now'))`,
      [frId, planId, projectId],
    );
    await db.execute(
      `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, 'under_review', 1, datetime('now'), datetime('now'))`,
      [featureRunId, frId],
    );
    await db.execute(
      `INSERT INTO pull_requests
         (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
          ci_status, mergeable, blocking_labels, conversations_resolved, version, created_at, updated_at)
       VALUES (?, ?, 21, 'minicoder/FR-001', 'main', 'headsha1', 'open', 'approved', 'passed', 1, '[]', 0, 1, datetime('now'), datetime('now'))`,
      [`pr-${featureRunId}`, featureRunId],
    );
    await db.execute(
      `INSERT INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId, featureRunId],
    );

    const client = fakeGithubClient();
    const resolveCalls: Array<{ provider: string; baseUrl: string | null }> = [];

    await runImpl(
      {
        projectId,
        correlationId: 'corr-run-merge-gate-provider-1',
        idempotencyKey: 'idem-run-merge-gate-provider-1',
        featureRunId,
      },
      db,
      {
        resolveScmClient: async (provider: string, baseUrl: string | null) => {
          resolveCalls.push({ provider, baseUrl });
          return client;
        },
      },
    );

    expect(resolveCalls).toEqual([{ provider: 'gitlab', baseUrl: 'https://gitlab.example.test' }]);
  });
});
