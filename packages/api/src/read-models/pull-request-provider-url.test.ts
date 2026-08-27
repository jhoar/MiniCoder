import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import type { DbClient } from '@minicoder/core';
import { getPullRequestByFeatureRun, listPullRequests } from './features.js';

/**
 * docs/06 §Phase 18 Stage 6: `getPullRequestByFeatureRun()`/`listPullRequests()` now attach a
 * `provider`/`provider_url` pair (via `buildScmPullRequestUrl()`) resolved from the PR's
 * repository row — this covers the actual read-model wiring (the repository lookup + join), not
 * just the pure URL-formatting function (`scm-url.test.ts` covers that in isolation).
 */

async function seedProjectWithRepoAndPr(
  db: DbClient,
  opts: { projectId: string; provider: string; baseUrl: string | null; prNumber: number },
): Promise<{ featureRunId: string }> {
  const { projectId, provider, baseUrl, prNumber } = opts;
  const featureRunId = `run-${projectId}`;
  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
    [projectId],
  );
  await db.execute(
    `INSERT INTO repositories (id, project_id, owner, name, full_name, default_branch, provider, base_url, version, created_at, updated_at)
     VALUES (?, ?, 'acme', 'widgets', 'acme/widgets', 'main', ?, ?, 1, datetime('now'), datetime('now'))`,
    [`repo-${projectId}`, projectId, provider, baseUrl],
  );
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
    [`plan-${projectId}`, projectId],
  );
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, 'code_pushed', 0, 1, datetime('now'), datetime('now'))`,
    [`fr-${projectId}`, `plan-${projectId}`, projectId],
  );
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
     VALUES (?, ?, 1, 'pr_opened', 1, datetime('now'), datetime('now'))`,
    [featureRunId, `fr-${projectId}`],
  );
  await db.execute(
    `INSERT INTO pull_requests
       (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
        ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
     VALUES (?, ?, ?, 'minicoder/run-1', 'main', 'sha-1', 'open', 'none',
             'pending', '[]', 0, 1, datetime('now'), datetime('now'))`,
    [`pr-${featureRunId}`, featureRunId, prNumber],
  );
  return { featureRunId };
}

describe('PullRequestRow provider/provider_url (docs/06 §Phase 18 Stage 6)', () => {
  it('getPullRequestByFeatureRun() builds a github.com link for a github-provider repository', async () => {
    const db = createTestDb() as unknown as DbClient;
    const { featureRunId } = await seedProjectWithRepoAndPr(db, {
      projectId: 'proj-scm-url-github',
      provider: 'github',
      baseUrl: null,
      prNumber: 42,
    });

    const pr = await getPullRequestByFeatureRun(db, featureRunId);
    expect(pr.provider).toBe('github');
    expect(pr.provider_url).toBe('https://github.com/acme/widgets/pull/42');
  });

  it('getPullRequestByFeatureRun() builds a Gitea link for a gitea-provider repository', async () => {
    const db = createTestDb() as unknown as DbClient;
    const { featureRunId } = await seedProjectWithRepoAndPr(db, {
      projectId: 'proj-scm-url-gitea',
      provider: 'gitea',
      baseUrl: 'https://gitea.example.test',
      prNumber: 7,
    });

    const pr = await getPullRequestByFeatureRun(db, featureRunId);
    expect(pr.provider).toBe('gitea');
    expect(pr.provider_url).toBe('https://gitea.example.test/acme/widgets/pulls/7');
  });

  it('listPullRequests() builds a GitLab link for a gitlab-provider repository', async () => {
    const db = createTestDb() as unknown as DbClient;
    await seedProjectWithRepoAndPr(db, {
      projectId: 'proj-scm-url-gitlab',
      provider: 'gitlab',
      baseUrl: 'https://gitlab.example.test',
      prNumber: 21,
    });

    const page = await listPullRequests(db, 'proj-scm-url-gitlab', {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.provider).toBe('gitlab');
    expect(page.items[0]?.provider_url).toBe(
      'https://gitlab.example.test/acme/widgets/-/merge_requests/21',
    );
  });

  it("returns provider 'unknown' and a null provider_url when no repository row exists", async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-scm-url-no-repo';
    const featureRunId = `run-${projectId}`;
    await db.execute(
      `INSERT INTO projects (id, name, state, version, created_at, updated_at)
       VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );
    await db.execute(
      `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
      [`plan-${projectId}`, projectId],
    );
    await db.execute(
      `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, 'code_pushed', 0, 1, datetime('now'), datetime('now'))`,
      [`fr-${projectId}`, `plan-${projectId}`, projectId],
    );
    await db.execute(
      `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, 'pr_opened', 1, datetime('now'), datetime('now'))`,
      [featureRunId, `fr-${projectId}`],
    );
    await db.execute(
      `INSERT INTO pull_requests
         (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
          ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
       VALUES (?, ?, 1, 'minicoder/run-1', 'main', 'sha-1', 'open', 'none',
               'pending', '[]', 0, 1, datetime('now'), datetime('now'))`,
      [`pr-${featureRunId}`, featureRunId],
    );

    const pr = await getPullRequestByFeatureRun(db, featureRunId);
    expect(pr.provider).toBe('unknown');
    expect(pr.provider_url).toBeNull();
  });
});
