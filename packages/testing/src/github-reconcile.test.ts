import { describe, it, expect } from 'vitest';
import { reconcileGithubState, FeatureExecutionState } from '@minicoder/core';
import type { ObservedPullRequestState } from '@minicoder/core';
import { createTestDb } from './db.js';

const PROJECT_ID = 'proj-reconcile-test';

async function seedProject(db: ReturnType<typeof createTestDb>): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, description, state, version, created_at, updated_at)
     VALUES (?, 'Reconcile Test Project', 'x', 'active', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
     VALUES ('repo-1', ?, 'acme', 'widgets', 'acme/widgets', 'main', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES ('plan-1', ?, NULL, 'activated_for_execution', 'Plan', 'x', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
}

let frCounter = 0;
let runCounter = 0;

async function seedFeatureRun(
  db: ReturnType<typeof createTestDb>,
  currentState: FeatureExecutionState,
): Promise<{ featureRequestId: string; featureRunId: string }> {
  frCounter += 1;
  runCounter += 1;
  const featureRequestId = `fr-${frCounter}`;
  const featureRunId = `run-${runCounter}`;
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, 'plan-1', ?, ?, 'Feature', 'x', 'feature', 1, 'approved_pending_execution', 0, 1, datetime('now'), datetime('now'))`,
    [featureRequestId, PROJECT_ID, `FR-${String(frCounter).padStart(3, '0')}`],
  );
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
     VALUES (?, ?, 1, ?, datetime('now'), 1, datetime('now'), datetime('now'))`,
    [featureRunId, featureRequestId, currentState],
  );
  return { featureRequestId, featureRunId };
}

async function seedPullRequestRow(
  db: ReturnType<typeof createTestDb>,
  featureRunId: string,
  opts: { prNumber: number; ciStatus?: string; reviewState?: string; state?: string },
): Promise<void> {
  await db.execute(
    `INSERT INTO pull_requests
       (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
        ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
     VALUES (?, ?, ?, 'minicoder/FR-001', 'main', 'sha1', ?, ?, ?, '[]', 0, 1, datetime('now'), datetime('now'))`,
    [
      `pr-${featureRunId}`,
      featureRunId,
      opts.prNumber,
      opts.state ?? 'open',
      opts.reviewState ?? 'none',
      opts.ciStatus ?? 'pending',
    ],
  );
}

async function seedLock(
  db: ReturnType<typeof createTestDb>,
): Promise<{ lockId: string; fence: number; holderId: string; resourceKey: string }> {
  const lockId = `lock-${PROJECT_ID}`;
  const holderId = 'test-holder';
  const resourceKey = `execution-lane:${PROJECT_ID}`;
  await db.execute(
    `INSERT INTO workflow_locks (id, project_id, resource_key, holder_id, fence, expires_at, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
    [lockId, PROJECT_ID, resourceKey, holderId, new Date(Date.now() + 60_000).toISOString()],
  );
  return { lockId, fence: 1, holderId, resourceKey };
}

function observed(overrides: Partial<ObservedPullRequestState> = {}): ObservedPullRequestState {
  return {
    prNumber: 10,
    branchName: 'minicoder/FR-001',
    baseBranch: 'main',
    headSha: 'sha1',
    state: 'open',
    reviewState: 'none',
    ciStatus: 'pending',
    mergeable: true,
    blockingLabels: [],
    conversationsResolved: true,
    mergedAt: null,
    mergeSha: null,
    closedAt: null,
    ...overrides,
  };
}

describe('reconcileGithubState', () => {
  it('opens a pull_requests row and transitions code_pushed -> pr_opened', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.CODE_PUSHED);
    const lockContext = await seedLock(db);

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 10 }),
      correlationId: 'corr-1',
      lockContext,
    });

    expect(result.action).toBe('pr_opened');
    expect(result.resultingState).toBe(FeatureExecutionState.PR_OPENED);

    const rows = await db.query<{ pr_number: number }>(
      `SELECT pr_number FROM pull_requests WHERE feature_run_id = ?`,
      [featureRunId],
    );
    expect(rows[0]?.pr_number).toBe(10);
  });

  it('transitions pr_opened -> ci_running when CI starts', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.PR_OPENED);
    await seedPullRequestRow(db, featureRunId, { prNumber: 11 });
    const lockContext = await seedLock(db);

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 11, ciStatus: 'running' }),
      correlationId: 'corr-2',
      lockContext,
    });

    expect(result.action).toBe('ci_running');
    expect(result.resultingState).toBe(FeatureExecutionState.CI_RUNNING);
  });

  it('transitions ci_running -> under_review when CI passes', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.CI_RUNNING);
    await seedPullRequestRow(db, featureRunId, { prNumber: 12, ciStatus: 'running' });

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 12, ciStatus: 'passed' }),
      correlationId: 'corr-3',
    });

    expect(result.action).toBe('ci_passed');
    expect(result.resultingState).toBe(FeatureExecutionState.UNDER_REVIEW);
  });

  it('transitions ci_running -> ci_failed when CI fails', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.CI_RUNNING);
    await seedPullRequestRow(db, featureRunId, { prNumber: 13, ciStatus: 'running' });

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 13, ciStatus: 'failed' }),
      correlationId: 'corr-4',
    });

    expect(result.action).toBe('ci_failed');
    expect(result.resultingState).toBe(FeatureExecutionState.CI_FAILED);
  });

  it('transitions under_review -> changes_requested on a changes-requested review', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.UNDER_REVIEW);
    await seedPullRequestRow(db, featureRunId, { prNumber: 14, ciStatus: 'passed' });

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 14, ciStatus: 'passed', reviewState: 'changes_requested' }),
      correlationId: 'corr-5',
    });

    expect(result.action).toBe('changes_requested');
    expect(result.resultingState).toBe(FeatureExecutionState.CHANGES_REQUESTED);
  });

  it('escalates to human_required when the PR closes unmerged while CI is running', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.CI_RUNNING);
    await seedPullRequestRow(db, featureRunId, { prNumber: 15, ciStatus: 'running' });

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 15, state: 'closed', mergedAt: null }),
      correlationId: 'corr-6',
    });

    expect(result.action).toBe('escalated');
    expect(result.resultingState).toBe(FeatureExecutionState.HUMAN_REQUIRED);
  });

  it('no-ops when the DB record already matches observed GitHub state', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.UNDER_REVIEW);
    await seedPullRequestRow(db, featureRunId, {
      prNumber: 16,
      ciStatus: 'passed',
      reviewState: 'approved',
    });

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 16, ciStatus: 'passed', reviewState: 'approved' }),
      correlationId: 'corr-7',
    });

    expect(result.action).toBe('none');
  });

  it('HIGH-2: catches up pr_opened -> under_review in one call when ci_running was missed and CI is already passed', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.PR_OPENED);
    await seedPullRequestRow(db, featureRunId, { prNumber: 18 });
    const lockContext = await seedLock(db);

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 18, ciStatus: 'passed' }),
      correlationId: 'corr-multi-1',
      lockContext,
    });

    expect(result.actions).toEqual(['ci_running', 'ci_passed']);
    expect(result.action).toBe('ci_passed');
    expect(result.resultingState).toBe(FeatureExecutionState.UNDER_REVIEW);

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.UNDER_REVIEW);
  });

  it('HIGH-2: catches up pr_opened -> ci_failed in one call when ci_running was missed and CI already failed', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.PR_OPENED);
    await seedPullRequestRow(db, featureRunId, { prNumber: 19 });
    const lockContext = await seedLock(db);

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 19, ciStatus: 'failed' }),
      correlationId: 'corr-multi-2',
      lockContext,
    });

    expect(result.actions).toEqual(['ci_running', 'ci_failed']);
    expect(result.action).toBe('ci_failed');
    expect(result.resultingState).toBe(FeatureExecutionState.CI_FAILED);
  });

  it('HIGH-3: full observed-state mirror sync writes every column, not just ci_status/review_state', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.UNDER_REVIEW);
    await seedPullRequestRow(db, featureRunId, { prNumber: 30, ciStatus: 'passed' });

    await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({
        prNumber: 30,
        ciStatus: 'passed',
        reviewState: 'approved',
        headSha: 'sha-mirror',
        mergeable: false,
        blockingLabels: ['do-not-merge'],
        conversationsResolved: false,
        mergedAt: null,
        mergeSha: null,
        closedAt: null,
      }),
      correlationId: 'corr-mirror-1',
    });

    const rows = await db.query<{
      head_sha: string;
      mergeable: number | null;
      blocking_labels: string;
      conversations_resolved: number;
      review_state: string;
    }>(
      `SELECT head_sha, mergeable, blocking_labels, conversations_resolved, review_state
       FROM pull_requests WHERE feature_run_id = ?`,
      [featureRunId],
    );
    expect(rows[0]?.head_sha).toBe('sha-mirror');
    expect(rows[0]?.mergeable).toBe(0);
    expect(JSON.parse(rows[0]?.blocking_labels ?? '[]')).toEqual(['do-not-merge']);
    expect(rows[0]?.conversations_resolved).toBe(0);
    expect(rows[0]?.review_state).toBe('approved');
  });

  it('MEDIUM-1: approved/commented/dismissed review states land in pull_requests.review_state without a feature-execution transition', async () => {
    for (const reviewState of ['approved', 'commented', 'dismissed'] as const) {
      const db = createTestDb();
      await seedProject(db);
      const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.UNDER_REVIEW);
      await seedPullRequestRow(db, featureRunId, { prNumber: 31, ciStatus: 'passed' });

      const result = await reconcileGithubState({
        db,
        featureRunId,
        projectId: PROJECT_ID,
        observed: observed({ prNumber: 31, ciStatus: 'passed', reviewState }),
        correlationId: `corr-review-${reviewState}`,
      });

      // No feature-execution transition: the matrix only gates on 'changes_requested'.
      expect(result.action).toBe('none');

      const runRows = await db.query<{ current_execution_state: string }>(
        `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
        [featureRunId],
      );
      expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.UNDER_REVIEW);

      const prRows = await db.query<{ review_state: string }>(
        `SELECT review_state FROM pull_requests WHERE feature_run_id = ?`,
        [featureRunId],
      );
      expect(prRows[0]?.review_state).toBe(reviewState);
    }
  });

  it('HIGH-1: fix-cycle re-push (code_pushed with an existing pull_requests row) advances past pr_opened instead of getting stuck', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.CODE_PUSHED);
    // Simulate a prior PR-open on this same PR (fix-cycle re-push reuses the same PR — GitHub
    // doesn't close and reopen a PR on a new commit) so a pull_requests row already exists.
    await seedPullRequestRow(db, featureRunId, { prNumber: 40, ciStatus: 'pending' });
    const lockContext = await seedLock(db);

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 40, headSha: 'sha-fix-1', ciStatus: 'pending' }),
      correlationId: 'corr-high1-a',
      lockContext,
    });

    expect(result.action).toBe('pr_opened');
    expect(result.resultingState).toBe(FeatureExecutionState.PR_OPENED);

    const runRows = await db.query<{ current_execution_state: string; version: number }>(
      `SELECT current_execution_state, version FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.PR_OPENED);
    const versionAfterFirstPass = runRows[0]?.version;

    // A second reconcile pass for the *same* commit (no new headSha) must not re-fire pr_opened —
    // true idempotency is preserved because the idempotency key is unchanged for the same commit.
    const secondPass = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 40, headSha: 'sha-fix-1', ciStatus: 'pending' }),
      correlationId: 'corr-high1-b',
      lockContext,
    });
    expect(secondPass.action).toBe('none');

    // Now simulate a *new* commit landing on the same PR (the defining event of a fix cycle) —
    // reconciliation must actually execute again, not short-circuit on the first pr-open's cached
    // idempotency claim, and the feature run's current_execution_state must genuinely reflect it
    // (not just a stale reported resultingState).
    await db.execute(`UPDATE feature_runs SET current_execution_state = ? WHERE id = ?`, [
      FeatureExecutionState.CODE_PUSHED,
      featureRunId,
    ]);
    const thirdPass = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 40, headSha: 'sha-fix-2', ciStatus: 'pending' }),
      correlationId: 'corr-high1-c',
      lockContext,
    });
    expect(thirdPass.action).toBe('pr_opened');
    expect(thirdPass.resultingState).toBe(FeatureExecutionState.PR_OPENED);

    const finalRunRows = await db.query<{ current_execution_state: string; version: number }>(
      `SELECT current_execution_state, version FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(finalRunRows[0]?.current_execution_state).toBe(FeatureExecutionState.PR_OPENED);
    expect(finalRunRows[0]?.version).toBeGreaterThan(versionAfterFirstPass ?? 0);

    const prRows = await db.query<{ head_sha: string }>(
      `SELECT head_sha FROM pull_requests WHERE feature_run_id = ?`,
      [featureRunId],
    );
    expect(prRows[0]?.head_sha).toBe('sha-fix-2');
  });

  it('HIGH-2: a pull_requests row created mid-loop ends up with real observed mergeable/blockingLabels/conversationsResolved, not insertPullRequestRow defaults', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.CODE_PUSHED);
    const lockContext = await seedLock(db);

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({
        prNumber: 41,
        ciStatus: 'passed',
        reviewState: 'approved',
        mergeable: false,
        blockingLabels: ['do-not-merge'],
        conversationsResolved: false,
      }),
      correlationId: 'corr-high2-a',
      lockContext,
    });

    // Single call catches up code_pushed -> pr_opened -> ci_running -> under_review.
    expect(result.resultingState).toBe(FeatureExecutionState.UNDER_REVIEW);

    const prRows = await db.query<{
      mergeable: number | null;
      blocking_labels: string;
      conversations_resolved: number;
    }>(
      `SELECT mergeable, blocking_labels, conversations_resolved FROM pull_requests WHERE feature_run_id = ?`,
      [featureRunId],
    );
    expect(prRows[0]?.mergeable).toBe(0);
    expect(JSON.parse(prRows[0]?.blocking_labels ?? '[]')).toEqual(['do-not-merge']);
    expect(prRows[0]?.conversations_resolved).toBe(0);
  });

  it('HIGH-3: reports lock_required instead of throwing when a lock-gated step is reached without lockContext', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.CODE_PUSHED);

    // No lockContext supplied — simulates a caller that decided (based on an earlier state read)
    // that no lock was needed, but by the time this call's own internal read ran, the feature run
    // had already been advanced into a lock-gated state by a concurrent writer.
    await expect(
      reconcileGithubState({
        db,
        featureRunId,
        projectId: PROJECT_ID,
        observed: observed({ prNumber: 50 }),
        correlationId: 'corr-high3-a',
      }),
    ).resolves.not.toThrow();

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 50 }),
      correlationId: 'corr-high3-b',
    });

    expect(result.action).toBe('lock_required');
    expect(result.actions).toEqual(['lock_required']);
    expect(result.resultingState).toBeUndefined();

    // The feature run must not have moved — the lock-gated step was never executed.
    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.CODE_PUSHED);

    // A caller's retry-with-lock succeeds and completes the transition, proving the narrow race
    // this fix targets resolves into a clean single extra retry rather than a thrown error.
    const lockContext = await seedLock(db);
    const retryResult = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 50 }),
      correlationId: 'corr-high3-c',
      lockContext,
    });
    expect(retryResult.action).toBe('pr_opened');
    expect(retryResult.resultingState).toBe(FeatureExecutionState.PR_OPENED);
  });

  it('does not escalate an already-merged PR', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.MERGED);
    await seedPullRequestRow(db, featureRunId, { prNumber: 17, state: 'merged' });

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({
        prNumber: 17,
        state: 'merged',
        mergedAt: new Date().toISOString(),
        mergeSha: 'mergesha1',
      }),
      correlationId: 'corr-8',
    });

    expect(result.action).toBe('none');
  });
});
