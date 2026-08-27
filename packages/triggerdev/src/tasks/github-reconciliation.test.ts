import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient, ScmClient, ObservedPullRequestState } from '@minicoder/core';
import { PrReviewState } from '@minicoder/core';
import { ExecutionLane } from '@minicoder/workflow';
import { createTestDb, insertTestProject } from '../test-helpers.js';
import { runImpl } from './github-reconciliation.js';

const PROJECT_ID = 'proj-hr2-001';
const PR_NUMBER = 77;

async function seedCodePushedFeatureRunWithTrackedPr(db: DbClient): Promise<string> {
  const planId = `plan-${PROJECT_ID}`;
  const frId = `fr-${PROJECT_ID}-1`;
  const featureRunId = `run-${PROJECT_ID}-1`;
  const pullRequestId = `pr-${PROJECT_ID}-1`;

  await db.execute(
    `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
     VALUES (?, ?, 'minicoder-test', 'hr2-repo', 'minicoder-test/hr2-repo', 'main', 1, datetime('now'), datetime('now'))`,
    [`repo-${PROJECT_ID}`, PROJECT_ID],
  );

  await db.execute(
    `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'HIGH-2 Regression Plan', 'Plan for HIGH-2 regression testing', 1, datetime('now'), datetime('now'))`,
    [planId, PROJECT_ID],
  );

  await db.execute(
    `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'HR2 Feature', 'Fix-cycle re-push whose pr.opened webhook was missed', 'feature', 1, 'code_pushed', 0, 1, datetime('now'), datetime('now'))`,
    [frId, planId, PROJECT_ID],
  );

  // The candidate's execution state is 'code_pushed' — the HIGH-2 regression: this must still be
  // scanned (and reach ScmClient.getPullRequest) because it already has a tracked
  // pull_requests row, i.e. this is a fix-cycle re-push whose pr.opened webhook was missed, not a
  // brand-new not-yet-opened PR.
  await db.execute(
    `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
     VALUES (?, ?, 2, 'code_pushed', datetime('now'), 1, datetime('now'), datetime('now'))`,
    [featureRunId, frId],
  );

  await db.execute(
    `INSERT OR IGNORE INTO pull_requests
       (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
        ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
     VALUES (?, ?, ?, 'minicoder/FR-001', 'main', 'oldsha0000', 'open', 'none', 'pending', '[]', 0, 1, datetime('now'), datetime('now'))`,
    [pullRequestId, featureRunId, PR_NUMBER],
  );

  return featureRunId;
}

function observedPrOpenedState(headSha: string): ObservedPullRequestState {
  return {
    prNumber: PR_NUMBER,
    branchName: 'minicoder/FR-001',
    baseBranch: 'main',
    headSha,
    state: 'open',
    reviewState: PrReviewState.NONE,
    ciStatus: 'pending',
    mergeable: null,
    blockingLabels: [],
    conversationsResolved: false,
    mergedAt: null,
    mergeSha: null,
    closedAt: null,
  };
}

/**
 * HIGH-2 code-review regression test (round 5): `EXCLUDED_STATES` previously included
 * `'code_pushed'`, filtering those feature runs out of the scheduled scan's SQL query entirely —
 * before the `candidate.pr_number === null` guard in `runImpl` ever ran. That meant a fix-cycle
 * re-push (`changes_requested -> fixing -> code_pushed`, reusing the same GitHub PR) whose
 * `pr.opened` webhook was missed could never be caught up by the scheduled fallback, even though
 * it already has a tracked `pull_requests` row and `reconcileGithubState` knows exactly how to
 * advance it (the `CODE_PUSHED -> pr_opened` branch). This test seeds exactly that scenario and
 * asserts the scheduled scan reaches `ScmClient.getPullRequest` for it and reconciles.
 */
describe('github-reconciliation runImpl (HIGH-2: code_pushed candidates with a tracked PR are scanned)', () => {
  it('includes a code_pushed feature run with an existing pull_requests row in the scheduled batch', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const featureRunId = await seedCodePushedFeatureRunWithTrackedPr(db);

    const getPullRequestCalls: Array<{ owner: string; repo: string; prNumber: number }> = [];
    const client: ScmClient = {
      async createBranch() {
        throw new Error('not used in this test');
      },
      async createPullRequest() {
        throw new Error('not used in this test');
      },
      async mergePullRequest() {
        throw new Error('not used in this test');
      },
      async getPullRequest(owner, repo, prNumber) {
        getPullRequestCalls.push({ owner, repo, prNumber });
        return observedPrOpenedState('newsha0000');
      },
      async publishStatusCheck() {
        // no-op
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

    const result = await runImpl(
      { projectId: PROJECT_ID, correlationId: 'corr-hr2', idempotencyKey: 'idem-hr2' },
      db,
      async () => client,
    );

    // The candidate reached ScmClient.getPullRequest at all — proof it was not filtered out of
    // the SQL scan by EXCLUDED_STATES before the pr_number-null guard could even run.
    expect(getPullRequestCalls).toEqual([
      { owner: 'minicoder-test', repo: 'hr2-repo', prNumber: PR_NUMBER },
    ]);
    expect(result.reconciled).toBeGreaterThan(0);

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    // CODE_PUSHED -> pr_opened is the expected catch-up transition once the missed webhook is
    // reconciled.
    expect(runRows[0]?.current_execution_state).toBe('pr_opened');
  });

  it('still skips a code_pushed candidate that has no tracked pull_requests row (genuinely new, not-yet-opened PR)', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);

    const planId = `plan-${PROJECT_ID}`;
    const frId = `fr-${PROJECT_ID}-2`;
    const featureRunId = `run-${PROJECT_ID}-2`;

    await db.execute(
      `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
       VALUES (?, ?, 'minicoder-test', 'hr2-repo', 'minicoder-test/hr2-repo', 'main', 1, datetime('now'), datetime('now'))`,
      [`repo-${PROJECT_ID}`, PROJECT_ID],
    );
    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'HIGH-2 No-PR Plan', 'Plan', 1, datetime('now'), datetime('now'))`,
      [planId, PROJECT_ID],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-002', 'No PR Yet', 'Never opened a PR', 'feature', 1, 'code_pushed', 0, 1, datetime('now'), datetime('now'))`,
      [frId, planId, PROJECT_ID],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
       VALUES (?, ?, 1, 'code_pushed', datetime('now'), 1, datetime('now'), datetime('now'))`,
      [featureRunId, frId],
    );

    let getPullRequestCallCount = 0;
    const client: ScmClient = {
      async createBranch() {
        throw new Error('not used in this test');
      },
      async createPullRequest() {
        throw new Error('not used in this test');
      },
      async mergePullRequest() {
        throw new Error('not used in this test');
      },
      async getPullRequest() {
        getPullRequestCallCount += 1;
        return observedPrOpenedState('irrelevant');
      },
      async publishStatusCheck() {
        // no-op
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

    const result = await runImpl(
      { projectId: PROJECT_ID, correlationId: 'corr-hr2-nopr', idempotencyKey: 'idem-hr2-nopr' },
      db,
      async () => client,
    );

    expect(getPullRequestCallCount).toBe(0);
    expect(result.reconciled).toBe(0);
  });
});

/**
 * Concurrency regression (round 6): a lock-gated candidate (`code_pushed`/`pr_opened`) whose
 * `execution-lane:{projectId}` lock is held by another worker (the start-next-feature task, a
 * webhook-triggered inbox handler, or an HA-cluster peer) used to throw an uncaught
 * `LockConflictError` out of the per-candidate loop, aborting reconciliation of the whole batch
 * and failing the task. The task must instead skip that one candidate and finish the batch; the
 * next scheduled fallback reconciles it once the lane frees.
 */
describe('github-reconciliation runImpl (concurrency: a held execution lane skips the candidate, not the batch)', () => {
  function prOpenedClient(): ScmClient {
    return {
      async createBranch() {
        throw new Error('not used in this test');
      },
      async createPullRequest() {
        throw new Error('not used in this test');
      },
      async mergePullRequest() {
        throw new Error('not used in this test');
      },
      async getPullRequest() {
        return observedPrOpenedState('newsha0000');
      },
      async publishStatusCheck() {
        // no-op
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

  it('skips a lock-gated candidate whose execution lane is held, without failing the task', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const featureRunId = await seedCodePushedFeatureRunWithTrackedPr(db);

    // A foreign holder grabs the project's execution lane (the same resource key
    // github-reconciliation acquires) before reconciliation runs.
    const foreignLane = new ExecutionLane(db);
    const foreignLock = await foreignLane.acquireForProject(PROJECT_ID, 'foreign-holder', 30_000);

    // Must NOT throw despite the LockConflictError from acquiring the held lane.
    const blocked = await runImpl(
      { projectId: PROJECT_ID, correlationId: 'corr-hr-lock', idempotencyKey: 'idem-hr-lock' },
      db,
      async () => prOpenedClient(),
    );
    expect(blocked.reconciled).toBe(0);
    expect(blocked.humanRequired).toBe(0);

    // The candidate is untouched (reconcileGithubState never ran — the lock could not be acquired),
    // so it is still code_pushed and its pull_requests row is unchanged.
    const blockedRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(blockedRows[0]?.current_execution_state).toBe('code_pushed');

    // Once the lane frees, a subsequent pass reconciles the candidate normally.
    await foreignLane.releaseForProject(foreignLock);
    const after = await runImpl(
      { projectId: PROJECT_ID, correlationId: 'corr-hr-free', idempotencyKey: 'idem-hr-free' },
      db,
      async () => prOpenedClient(),
    );
    expect(after.reconciled).toBeGreaterThan(0);
    const afterRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(afterRows[0]?.current_execution_state).toBe('pr_opened');
  });
});

/**
 * LOW-1 code-review fix (round 5): `requireNonBlankEnvVar()` was extracted from `run-coder.ts`
 * into a shared `env.ts` and adopted here so both GitHub-facing task entrypoints reject a
 * whitespace-only `GITHUB_TOKEN` identically instead of one silently accepting it and failing
 * later with a less actionable Octokit auth error.
 */
/**
 * Issue #42: a `ScmClient.getPullRequest()` failure on one candidate must not prevent other
 * candidates in the same scheduled pass from being reconciled.
 */
async function seedTwoTrackedCandidates(
  db: DbClient,
): Promise<{ okRunId: string; failRunId: string; okPrNumber: number; failPrNumber: number }> {
  const planId = `plan-${PROJECT_ID}-two`;
  const okPrNumber = 201;
  const failPrNumber = 202;
  const okRunId = `run-${PROJECT_ID}-ok`;
  const failRunId = `run-${PROJECT_ID}-fail`;

  await db.execute(
    `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
     VALUES (?, ?, 'minicoder-test', 'hr2-repo', 'minicoder-test/hr2-repo', 'main', 1, datetime('now'), datetime('now'))`,
    [`repo-${PROJECT_ID}`, PROJECT_ID],
  );
  await db.execute(
    `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Two Candidates Plan', 'Plan', 1, datetime('now'), datetime('now'))`,
    [planId, PROJECT_ID],
  );

  for (const [runId, frSuffix, prNumber] of [
    [okRunId, 'ok', okPrNumber],
    [failRunId, 'fail', failPrNumber],
  ] as const) {
    const frId = `fr-${PROJECT_ID}-${frSuffix}`;
    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Feature', 'Description', 'feature', 1, 'code_pushed', 0, 1, datetime('now'), datetime('now'))`,
      [frId, planId, PROJECT_ID, `FR-${frSuffix.toUpperCase()}`],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
       VALUES (?, ?, 1, 'code_pushed', datetime('now'), 1, datetime('now'), datetime('now'))`,
      [runId, frId],
    );
    await db.execute(
      `INSERT OR IGNORE INTO pull_requests
         (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
          ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', 'sha0000', 'open', 'none', 'pending', '[]', 0, 1, datetime('now'), datetime('now'))`,
      [`pr-${runId}`, runId, prNumber, `minicoder/${frSuffix}`],
    );
  }

  return { okRunId, failRunId, okPrNumber, failPrNumber };
}

describe('github-reconciliation runImpl (issue #42: per-candidate GitHub API failure isolation)', () => {
  it('a getPullRequest failure on one candidate does not prevent the other candidate from reconciling', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { okRunId, failPrNumber } = await seedTwoTrackedCandidates(db);

    const client: ScmClient = {
      async createBranch() {
        return { branchName: 'x', sha: 'abc' };
      },
      async createPullRequest() {
        throw new Error('not used');
      },
      async mergePullRequest() {
        throw new Error('not used');
      },
      async getPullRequest(_owner, _repo, prNumber) {
        if (prNumber === failPrNumber) {
          throw new Error('simulated transient GitHub API failure');
        }
        return {
          prNumber,
          branchName: 'minicoder/ok',
          baseBranch: 'main',
          headSha: 'sha-new',
          state: 'open',
          reviewState: PrReviewState.NONE,
          ciStatus: 'pending',
          mergeable: null,
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

    const result = await runImpl(
      { projectId: PROJECT_ID, correlationId: 'corr-hr-42', idempotencyKey: 'idem-hr-42' },
      db,
      async () => client,
    );

    expect(result.fetchFailures).toBe(1);
    // The 'ok' candidate still reached reconcileGithubState and advanced past code_pushed.
    const okRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [okRunId],
    );
    expect(okRows[0]?.current_execution_state).not.toBe('code_pushed');
  });

  it('a 401/403 credential failure aborts the whole batch instead of being skipped per candidate', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    await seedTwoTrackedCandidates(db);

    const authError = Object.assign(new Error('Bad credentials'), { status: 401 });
    const client: ScmClient = {
      async createBranch() {
        return { branchName: 'x', sha: 'abc' };
      },
      async createPullRequest() {
        throw new Error('not used');
      },
      async mergePullRequest() {
        throw new Error('not used');
      },
      async getPullRequest() {
        throw authError;
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

    await expect(
      runImpl(
        { projectId: PROJECT_ID, correlationId: 'corr-hr-42b', idempotencyKey: 'idem-hr-42b' },
        db,
        async () => client,
      ),
    ).rejects.toThrow('Bad credentials');
  });
});

describe('github-reconciliation runImpl (required env var validation, round 5)', () => {
  const savedToken = process.env['GITHUB_TOKEN'];

  beforeEach(() => {
    process.env['GITHUB_TOKEN'] = savedToken;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env['GITHUB_TOKEN'];
    else process.env['GITHUB_TOKEN'] = savedToken;
  });

  it.each(['', '   '])(
    'the default github client factory rejects a whitespace-only GITHUB_TOKEN (%j)',
    async (blankValue) => {
      process.env['GITHUB_TOKEN'] = blankValue;

      const db = createTestDb();
      insertTestProject(db, PROJECT_ID);
      await seedCodePushedFeatureRunWithTrackedPr(db);

      await expect(
        runImpl(
          { projectId: PROJECT_ID, correlationId: 'corr-hr-env', idempotencyKey: 'idem-hr-env' },
          db,
        ),
      ).rejects.toThrow(/GITHUB_TOKEN is not configured/);
    },
  );
});

const DISCOVERY_PROJECT_ID = 'proj-hr35-001';
const DISCOVERY_PR_NUMBER = 88;

/** Seeds a feature run at `code_pushed` with NO tracked `pull_requests` row — the exact gap
 * issue #35 closes: a coder push happened, but no webhook (or this task) has ever recorded the
 * resulting PR. The real branch-naming convention actually used at runtime is
 * `minicoder/<featureRunId>` (`branchNameFor()` in `@minicoder/adapters-coder`), not the
 * `minicoder/FR-<n>` form docs/00 §3.11 describes — see the doc comment on
 * `discoverMissingPullRequests()` for why this test seeds/expects the former. */
async function seedCodePushedFeatureRunWithNoTrackedPr(db: DbClient): Promise<string> {
  const planId = `plan-${DISCOVERY_PROJECT_ID}`;
  const frId = `fr-${DISCOVERY_PROJECT_ID}-1`;
  const featureRunId = `run-${DISCOVERY_PROJECT_ID}-1`;

  await db.execute(
    `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
     VALUES (?, ?, 'minicoder-test', 'hr35-repo', 'minicoder-test/hr35-repo', 'main', 1, datetime('now'), datetime('now'))`,
    [`repo-${DISCOVERY_PROJECT_ID}`, DISCOVERY_PROJECT_ID],
  );
  await db.execute(
    `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Issue 35 Discovery Plan', 'Plan for PR discovery regression testing', 1, datetime('now'), datetime('now'))`,
    [planId, DISCOVERY_PROJECT_ID],
  );
  await db.execute(
    `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Discovery Feature', 'A brand-new PR whose webhook was missed', 'feature', 1, 'code_pushed', 0, 1, datetime('now'), datetime('now'))`,
    [frId, planId, DISCOVERY_PROJECT_ID],
  );
  await db.execute(
    `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
     VALUES (?, ?, 1, 'code_pushed', datetime('now'), 1, datetime('now'), datetime('now'))`,
    [featureRunId, frId],
  );

  return featureRunId;
}

function discoveredObservedState(prNumber: number, headSha: string): ObservedPullRequestState {
  return {
    prNumber,
    branchName: `minicoder/run-${DISCOVERY_PROJECT_ID}-1`,
    baseBranch: 'main',
    headSha,
    state: 'open',
    reviewState: PrReviewState.NONE,
    ciStatus: 'pending',
    mergeable: null,
    blockingLabels: [],
    conversationsResolved: false,
    mergedAt: null,
    mergeSha: null,
    closedAt: null,
  };
}

describe('github-reconciliation runImpl (issue #35: automated PR discovery)', () => {
  it('auto-creates the pull_requests row for a code_pushed run whose PR was never reported by a webhook', async () => {
    const db = createTestDb();
    insertTestProject(db, DISCOVERY_PROJECT_ID);
    const featureRunId = await seedCodePushedFeatureRunWithNoTrackedPr(db);

    const listCalls: Array<{ owner: string; repo: string; branchName: string; state?: string }> =
      [];
    const client: ScmClient = {
      async createBranch() {
        throw new Error('not used in this test');
      },
      async createPullRequest() {
        throw new Error('not used in this test');
      },
      async mergePullRequest() {
        throw new Error('not used in this test');
      },
      async getPullRequest() {
        return discoveredObservedState(DISCOVERY_PR_NUMBER, 'discoveredsha0000');
      },
      async publishStatusCheck() {
        // no-op
      },
      async getRemainingRateLimit() {
        return 5000;
      },
      async getPullRequestDiff() {
        return '';
      },
      async listPullRequestsForBranch(owner, repo, branchName, state) {
        listCalls.push({ owner, repo, branchName, state });
        return [{ prNumber: DISCOVERY_PR_NUMBER, state: 'open' }];
      },
    };

    const result = await runImpl(
      { projectId: DISCOVERY_PROJECT_ID, correlationId: 'corr-hr35', idempotencyKey: 'idem-hr35' },
      db,
      async () => client,
    );

    expect(result.discovered).toBe(1);
    expect(listCalls).toEqual([
      {
        owner: 'minicoder-test',
        repo: 'hr35-repo',
        branchName: `minicoder/${featureRunId}`,
        state: 'open',
      },
    ]);

    const prRows = await db.query<{ pr_number: number; feature_run_id: string }>(
      `SELECT pr_number, feature_run_id FROM pull_requests WHERE feature_run_id = ?`,
      [featureRunId],
    );
    expect(prRows).toHaveLength(1);
    expect(prRows[0]?.pr_number).toBe(DISCOVERY_PR_NUMBER);

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe('pr_opened');
  });

  it('does not create a pull_requests row when no PR exists yet for the branch', async () => {
    const db = createTestDb();
    insertTestProject(db, DISCOVERY_PROJECT_ID);
    const featureRunId = await seedCodePushedFeatureRunWithNoTrackedPr(db);

    const client: ScmClient = {
      async createBranch() {
        throw new Error('not used in this test');
      },
      async createPullRequest() {
        throw new Error('not used in this test');
      },
      async mergePullRequest() {
        throw new Error('not used in this test');
      },
      async getPullRequest() {
        throw new Error('not used in this test');
      },
      async publishStatusCheck() {
        // no-op
      },
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

    const result = await runImpl(
      {
        projectId: DISCOVERY_PROJECT_ID,
        correlationId: 'corr-hr35b',
        idempotencyKey: 'idem-hr35b',
      },
      db,
      async () => client,
    );

    expect(result.discovered).toBe(0);
    const prRows = await db.query<{ id: string }>(
      `SELECT id FROM pull_requests WHERE feature_run_id = ?`,
      [featureRunId],
    );
    expect(prRows).toHaveLength(0);
  });

  it('skips (does not abort the pass) when listPullRequestsForBranch fails for one discovery candidate', async () => {
    const db = createTestDb();
    insertTestProject(db, DISCOVERY_PROJECT_ID);
    await seedCodePushedFeatureRunWithNoTrackedPr(db);

    const client: ScmClient = {
      async createBranch() {
        throw new Error('not used in this test');
      },
      async createPullRequest() {
        throw new Error('not used in this test');
      },
      async mergePullRequest() {
        throw new Error('not used in this test');
      },
      async getPullRequest() {
        throw new Error('not used in this test');
      },
      async publishStatusCheck() {
        // no-op
      },
      async getRemainingRateLimit() {
        return 5000;
      },
      async getPullRequestDiff() {
        return '';
      },
      async listPullRequestsForBranch() {
        throw new Error('simulated transient GitHub API failure');
      },
    };

    const result = await runImpl(
      {
        projectId: DISCOVERY_PROJECT_ID,
        correlationId: 'corr-hr35c',
        idempotencyKey: 'idem-hr35c',
      },
      db,
      async () => client,
    );

    expect(result.discovered).toBe(0);
  });
});
