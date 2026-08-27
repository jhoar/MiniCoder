import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import type { DbClient, ScmClient } from '@minicoder/core';
import { checkPrDiscoveryDivergence } from './diagnostics.js';

/**
 * Issue #35: unit coverage for the opt-in `checkPrDiscoveryDivergence` doctor check —
 * `runDoctorChecks()` itself is pure-DB and untouched; this check needs a live `ScmClient`
 * (a fake here, mirroring `MockGitHubClient`'s shape) to ask GitHub whether an untracked
 * `code_pushed` feature run's branch already has an open PR.
 */

const PROJECT_ID = 'proj-pr-discovery-doctor';

async function seedCodePushedFeatureRunWithNoTrackedPr(db: DbClient): Promise<string> {
  const planId = `plan-${PROJECT_ID}`;
  const frId = `fr-${PROJECT_ID}-1`;
  const featureRunId = `run-${PROJECT_ID}-1`;

  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
     VALUES (?, ?, 'acme', 'widgets', 'acme/widgets', 'main', 1, datetime('now'), datetime('now'))`,
    [`repo-${PROJECT_ID}`, PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
    [planId, PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, 'code_pushed', 0, 1, datetime('now'), datetime('now'))`,
    [frId, planId, PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
     VALUES (?, ?, 1, 'code_pushed', 1, datetime('now'), datetime('now'))`,
    [featureRunId, frId],
  );

  return featureRunId;
}

function fakeGithubClient(
  matches: Record<string, Array<{ prNumber: number; state: 'open' | 'closed' | 'merged' }>>,
): ScmClient {
  return {
    async createBranch() {
      throw new Error('not used');
    },
    async createPullRequest() {
      throw new Error('not used');
    },
    async mergePullRequest() {
      throw new Error('not used');
    },
    async getPullRequest() {
      return null;
    },
    async publishStatusCheck() {},
    async getRemainingRateLimit() {
      return 5000;
    },
    async getPullRequestDiff() {
      return '';
    },
    async listPullRequestsForBranch(_owner, _repo, branchName) {
      return matches[branchName] ?? [];
    },
  };
}

describe('checkPrDiscoveryDivergence', () => {
  it('reports a divergence when GitHub already has an open PR for an untracked branch', async () => {
    const db = createTestDb() as unknown as DbClient;
    const featureRunId = await seedCodePushedFeatureRunWithNoTrackedPr(db);
    const branchName = `minicoder/${featureRunId}`;
    const client = fakeGithubClient({ [branchName]: [{ prNumber: 42, state: 'open' }] });

    const divergences = await checkPrDiscoveryDivergence(db, client, PROJECT_ID);

    expect(divergences).toEqual([{ featureRunId, branchName, prNumberOnGithub: 42 }]);
  });

  it('reports no divergence when GitHub has no PR for the branch', async () => {
    const db = createTestDb() as unknown as DbClient;
    await seedCodePushedFeatureRunWithNoTrackedPr(db);
    const client = fakeGithubClient({});

    const divergences = await checkPrDiscoveryDivergence(db, client, PROJECT_ID);

    expect(divergences).toEqual([]);
  });

  it('scopes to the given project when other projects have their own untracked candidates', async () => {
    const db = createTestDb() as unknown as DbClient;
    await seedCodePushedFeatureRunWithNoTrackedPr(db);

    const otherProjectId = 'proj-pr-discovery-other';
    await db.execute(
      `INSERT INTO projects (id, name, state, version, created_at, updated_at)
       VALUES (?, 'Other Project', 'active', 1, datetime('now'), datetime('now'))`,
      [otherProjectId],
    );
    await db.execute(
      `INSERT INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
       VALUES (?, ?, 'acme', 'other-repo', 'acme/other-repo', 'main', 1, datetime('now'), datetime('now'))`,
      [`repo-${otherProjectId}`, otherProjectId],
    );
    const otherPlanId = `plan-${otherProjectId}`;
    const otherFrId = `fr-${otherProjectId}-1`;
    const otherFeatureRunId = `run-${otherProjectId}-1`;
    await db.execute(
      `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
      [otherPlanId, otherProjectId],
    );
    await db.execute(
      `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, 'code_pushed', 0, 1, datetime('now'), datetime('now'))`,
      [otherFrId, otherPlanId, otherProjectId],
    );
    await db.execute(
      `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, 'code_pushed', 1, datetime('now'), datetime('now'))`,
      [otherFeatureRunId, otherFrId],
    );

    const client = fakeGithubClient({
      [`minicoder/${otherFeatureRunId}`]: [{ prNumber: 99, state: 'open' }],
    });

    const divergences = await checkPrDiscoveryDivergence(db, client, PROJECT_ID);
    expect(divergences).toEqual([]);
  });
});
