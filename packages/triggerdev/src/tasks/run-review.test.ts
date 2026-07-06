import { describe, it, expect } from 'vitest';
import type {
  CommandEnvelope,
  DbClient,
  EscalateToHumanPayload,
  GitHubClient,
  RecordChangesRequestedPayload,
  ReviewerAgentAdapter,
  ReviewerInput,
  ReviewerOutput,
} from '@minicoder/core';
import {
  FeatureExecutionState,
  RecordChangesRequestedHandler,
  EscalateToHumanHandler,
  OptimisticLockError,
  generateId,
} from '@minicoder/core';
import { createTestDb, insertTestProject } from '../test-helpers.js';
import { systemActor } from './actor.js';
import { runImpl, type RunReviewDeps } from './run-review.js';

const PROJECT_ID = 'proj-run-review-001';

interface FixtureIds {
  featureRunId: string;
}

async function seedUnderReviewFeatureRun(
  db: DbClient,
  opts: { state?: string; fixAttemptCount?: number } = {},
): Promise<FixtureIds> {
  const planId = `plan-${PROJECT_ID}`;
  const frId = `fr-${PROJECT_ID}-1`;
  const featureRunId = `run-${PROJECT_ID}-1`;

  await db.execute(
    `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
     VALUES (?, ?, 'minicoder-test', 'run-review-repo', 'minicoder-test/run-review-repo', 'main', 1, datetime('now'), datetime('now'))`,
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
    `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, fix_attempt_count, version, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, 1, datetime('now'), datetime('now'))`,
    [
      featureRunId,
      frId,
      opts.state ?? FeatureExecutionState.UNDER_REVIEW,
      opts.fixAttemptCount ?? 0,
    ],
  );
  await db.execute(
    `INSERT OR IGNORE INTO pull_requests (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state, ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
     VALUES (?, ?, 7, 'minicoder/x', 'main', 'sha1', 'open', 'none', 'pending', '[]', 0, 1, datetime('now'), datetime('now'))`,
    [`pr-${featureRunId}`, featureRunId],
  );
  await db.execute(
    `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))`,
    [`ws-${PROJECT_ID}`, PROJECT_ID, featureRunId],
  );

  return { featureRunId };
}

async function registerReviewerAdapter(db: DbClient, name = 'FakeReviewerAdapter'): Promise<void> {
  const now = new Date().toISOString();
  const adapterId = `adapter-${name}`;
  await db.execute(
    `INSERT OR IGNORE INTO agent_adapters (id, role, name, implementation, is_active, version, created_at, updated_at)
     VALUES (?, 'ReviewerAgentAdapter', ?, 'test:FakeReviewerAdapter', 1, 1, ?, ?)`,
    [adapterId, name, now, now],
  );
  for (const capability of ['can_review_pull_request', 'can_return_structured_findings']) {
    await db.execute(
      `INSERT OR IGNORE INTO agent_capabilities (id, adapter_id, capability, created_at) VALUES (?, ?, ?, ?)`,
      [`${adapterId}-${capability}`, adapterId, capability, now],
    );
  }
}

function fakeReviewerAdapter(output: ReviewerOutput): ReviewerAgentAdapter {
  return {
    role: 'ReviewerAgentAdapter',
    async run(_input: ReviewerInput): Promise<ReviewerOutput> {
      return output;
    },
  };
}

function fakeGithubClient(): GitHubClient {
  return {
    async createBranch() {
      return { branchName: 'minicoder/x', sha: 'abc' };
    },
    async createPullRequest() {
      throw new Error('not used in this test');
    },
    async mergePullRequest() {
      throw new Error('not used in this test');
    },
    async getPullRequest() {
      return null;
    },
    async publishStatusCheck() {},
    async getRemainingRateLimit() {
      return 5000;
    },
    async getPullRequestDiff() {
      return 'diff --git a/x b/x\n';
    },
  };
}

describe('run-review', () => {
  it('no-ops when the feature run is not at under_review', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedUnderReviewFeatureRun(db, {
      state: FeatureExecutionState.CODING,
    });
    await registerReviewerAdapter(db);

    const result = await runImpl(
      {
        projectId: PROJECT_ID,
        featureRunId,
        correlationId: 'corr-1',
        idempotencyKey: 'idem-1',
        reviewerAdapterName: 'FakeReviewerAdapter',
      },
      db,
    );

    expect(result.reviewed).toBe(false);
    expect(result.decision).toBeNull();
  });

  it('approval leaves the feature run at under_review and records findings', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedUnderReviewFeatureRun(db);
    await registerReviewerAdapter(db);

    const adapter = fakeReviewerAdapter({
      decision: 'approved',
      findings: [{ severity: 'non_blocking', category: 'style', description: 'minor nit' }],
    });
    const deps: RunReviewDeps = {
      reviewerAdapterFactory: async () => adapter,
      githubClientFactory: async () => fakeGithubClient(),
    };

    const result = await runImpl(
      {
        projectId: PROJECT_ID,
        featureRunId,
        correlationId: 'corr-2',
        idempotencyKey: 'idem-2',
        reviewerAdapterName: 'FakeReviewerAdapter',
      },
      db,
      deps,
    );

    expect(result.reviewed).toBe(true);
    expect(result.decision).toBe('approved');

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.UNDER_REVIEW);

    const findings = await db.query<{ severity: string }>(
      `SELECT severity FROM review_findings WHERE feature_run_id = ?`,
      [featureRunId],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('non_blocking');
  });

  it('a blocking finding transitions under_review -> changes_requested -> fixing', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedUnderReviewFeatureRun(db);
    await registerReviewerAdapter(db);

    const adapter = fakeReviewerAdapter({
      decision: 'changes_requested',
      findings: [{ severity: 'blocking', category: 'correctness', description: 'bug' }],
    });
    const deps: RunReviewDeps = {
      reviewerAdapterFactory: async () => adapter,
      githubClientFactory: async () => fakeGithubClient(),
    };

    const result = await runImpl(
      {
        projectId: PROJECT_ID,
        featureRunId,
        correlationId: 'corr-3',
        idempotencyKey: 'idem-3',
        reviewerAdapterName: 'FakeReviewerAdapter',
      },
      db,
      deps,
    );

    expect(result.decision).toBe('changes_requested');

    const runRows = await db.query<{ current_execution_state: string; fix_attempt_count: number }>(
      `SELECT current_execution_state, fix_attempt_count FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.FIXING);
    expect(runRows[0]?.fix_attempt_count).toBe(1);
  });

  // Issue #48: advanceToFixing()'s StartFixingCommand dispatch can throw an 'automation-paused'
  // CommandError if automation is paused at that exact moment. This must be swallowed the same
  // way github-reconciliation.ts already swallows the identical condition on the identical
  // command, rather than throwing out of the task — the changes_requested transition is already
  // durably recorded by this point, so this is a benign, retryable race, not a task failure.
  it('does not throw when automation is paused mid-flight during the changes_requested -> fixing hop', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedUnderReviewFeatureRun(db);
    await registerReviewerAdapter(db);
    await db.execute(
      `UPDATE workflow_states SET automation_state = 'paused_by_operator', version = version + 1 WHERE project_id = ?`,
      [PROJECT_ID],
    );

    const adapter = fakeReviewerAdapter({
      decision: 'changes_requested',
      findings: [{ severity: 'blocking', category: 'correctness', description: 'bug' }],
    });
    const deps: RunReviewDeps = {
      reviewerAdapterFactory: async () => adapter,
      githubClientFactory: async () => fakeGithubClient(),
    };

    const result = await runImpl(
      {
        projectId: PROJECT_ID,
        featureRunId,
        correlationId: 'corr-3b',
        idempotencyKey: 'idem-3b',
        reviewerAdapterName: 'FakeReviewerAdapter',
      },
      db,
      deps,
    );

    expect(result.decision).toBe('changes_requested');

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    // The changes_requested transition succeeded (RecordChangesRequestedCommand has no
    // automation-state guard); only the -> fixing hop was skipped because automation is paused.
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.CHANGES_REQUESTED);
  });

  it('escalates to human_required when the fix-attempt threshold is already reached', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedUnderReviewFeatureRun(db, { fixAttemptCount: 5 });
    await registerReviewerAdapter(db);

    const adapter = fakeReviewerAdapter({
      decision: 'changes_requested',
      findings: [{ severity: 'blocking', category: 'correctness', description: 'bug' }],
    });
    const deps: RunReviewDeps = {
      reviewerAdapterFactory: async () => adapter,
      githubClientFactory: async () => fakeGithubClient(),
    };

    const result = await runImpl(
      {
        projectId: PROJECT_ID,
        featureRunId,
        correlationId: 'corr-4',
        idempotencyKey: 'idem-4',
        reviewerAdapterName: 'FakeReviewerAdapter',
      },
      db,
      deps,
    );

    expect(result.decision).toBe('escalated');

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.HUMAN_REQUIRED);
  });

  it('escalates to human_required on a requires_human_decision finding', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedUnderReviewFeatureRun(db);
    await registerReviewerAdapter(db);

    const adapter = fakeReviewerAdapter({
      decision: 'changes_requested',
      findings: [
        { severity: 'requires_human_decision', category: 'policy', description: 'ambiguous' },
      ],
    });
    const deps: RunReviewDeps = {
      reviewerAdapterFactory: async () => adapter,
      githubClientFactory: async () => fakeGithubClient(),
    };

    const result = await runImpl(
      {
        projectId: PROJECT_ID,
        featureRunId,
        correlationId: 'corr-5',
        idempotencyKey: 'idem-5',
        reviewerAdapterName: 'FakeReviewerAdapter',
      },
      db,
      deps,
    );

    expect(result.decision).toBe('escalated');

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.HUMAN_REQUIRED);
  });

  it('HIGH-3 (Phase 10 PR review): resumes a feature run stranded at changes_requested (a prior invocation recorded the review but never reached fixing) without re-invoking the reviewer', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedUnderReviewFeatureRun(db, {
      state: FeatureExecutionState.CHANGES_REQUESTED,
      fixAttemptCount: 1,
    });
    await registerReviewerAdapter(db);

    const deps: RunReviewDeps = {
      reviewerAdapterFactory: async () => {
        throw new Error('reviewer must not be invoked when resuming from changes_requested');
      },
      githubClientFactory: async () => fakeGithubClient(),
    };

    const result = await runImpl(
      {
        projectId: PROJECT_ID,
        featureRunId,
        correlationId: 'corr-6',
        idempotencyKey: 'idem-6',
        reviewerAdapterName: 'FakeReviewerAdapter',
      },
      db,
      deps,
    );

    expect(result.reviewed).toBe(true);
    expect(result.decision).toBe('changes_requested');

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.FIXING);
  });

  describe('HIGH-1 code-review fix (round 2): findings write atomically with the state transition', () => {
    it('RecordChangesRequestedHandler: a guard failure (stale expectedVersion) leaves no review_findings row despite findings in the payload', async () => {
      const db = createTestDb();
      insertTestProject(db, PROJECT_ID);
      const { featureRunId } = await seedUnderReviewFeatureRun(db);

      const handler = new RecordChangesRequestedHandler();
      const correlationId = 'corr-atomic-1';
      const envelope: CommandEnvelope<RecordChangesRequestedPayload> = {
        commandId: generateId(),
        idempotencyKey: `changes-requested:${featureRunId}:review-atomic-1`,
        payload: {
          featureRunId,
          projectId: PROJECT_ID,
          // Deliberately stale — the seeded run is at version 1 — to force assertVersion to
          // throw before the review_findings insert (which happens after the state UPDATE).
          expectedVersion: 99,
          reviewId: 'review-atomic-1',
          reviewerRunId: 'agent-run-atomic',
          reviewCycle: 1,
          findings: [{ severity: 'blocking', category: 'correctness', description: 'bug' }],
        },
        actor: systemActor(correlationId),
        correlationId,
      };

      await expect(handler.execute(envelope, db)).rejects.toBeInstanceOf(OptimisticLockError);

      const findings = await db.query<{ id: string }>(
        `SELECT id FROM review_findings WHERE feature_run_id = ?`,
        [featureRunId],
      );
      expect(findings).toHaveLength(0);

      const runRows = await db.query<{ current_execution_state: string }>(
        `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
        [featureRunId],
      );
      expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.UNDER_REVIEW);
    });

    it('EscalateToHumanHandler: a guard failure (stale expectedVersion) leaves no review_findings row despite findings in the payload', async () => {
      const db = createTestDb();
      insertTestProject(db, PROJECT_ID);
      const { featureRunId } = await seedUnderReviewFeatureRun(db);

      const handler = new EscalateToHumanHandler();
      const correlationId = 'corr-atomic-2';
      const envelope: CommandEnvelope<EscalateToHumanPayload> = {
        commandId: generateId(),
        idempotencyKey: `escalate-human-review:${featureRunId}`,
        payload: {
          featureRunId,
          projectId: PROJECT_ID,
          expectedVersion: 99,
          reason: 'requires_human_decision',
          reviewerRunId: 'agent-run-atomic',
          reviewCycle: 1,
          findings: [
            { severity: 'requires_human_decision', category: 'policy', description: 'ambiguous' },
          ],
        },
        actor: systemActor(correlationId),
        correlationId,
      };

      await expect(handler.execute(envelope, db)).rejects.toBeInstanceOf(OptimisticLockError);

      const findings = await db.query<{ id: string }>(
        `SELECT id FROM review_findings WHERE feature_run_id = ?`,
        [featureRunId],
      );
      expect(findings).toHaveLength(0);

      const runRows = await db.query<{ current_execution_state: string }>(
        `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
        [featureRunId],
      );
      expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.UNDER_REVIEW);
    });
  });
});
