import { describe, it, expect } from 'vitest';
import {
  reconcileGithubState,
  FeatureExecutionState,
  FeatureCiRunningPayloadSchema,
  FeatureCiResultPayloadSchema,
  FeaturePrOpenedPayloadSchema,
  FeatureChangesRequestedPayloadSchema,
  FeatureHumanRequiredPayloadSchema,
} from '@minicoder/core';
import type { ObservedPullRequestState } from '@minicoder/core';
import { createTestDb } from './db.js';

/**
 * HIGH-6 code-review fix regression coverage: every outbox payload the Phase 7 GitHub handlers
 * emit (via reconcileGithubState, exercising the real handlers end-to-end rather than
 * hand-constructing payload shapes) must parse against its registered EVENT_SCHEMAS entry.
 * `feature.ci_passed`/`feature.ci_failed` were missing the required `conclusion` field
 * (RecordCiPassedHandler/RecordCiFailedHandler); this also spot-checks
 * `feature.pr_opened`/`feature.ci_running`/`feature.changes_requested`/`feature.human_required`,
 * which weren't registered in EVENT_SCHEMAS at all before this fix.
 */

const PROJECT_ID = 'proj-outbox-schema-test';

async function seedProject(db: ReturnType<typeof createTestDb>): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, description, state, version, created_at, updated_at)
     VALUES (?, 'Outbox Schema Test Project', 'x', 'active', 1, datetime('now'), datetime('now'))`,
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
): Promise<{ featureRunId: string }> {
  frCounter += 1;
  runCounter += 1;
  const featureRequestId = `fr-${frCounter}`;
  // Deliberately non-UUID, matching commands/helpers.ts's real generateId() format
  // (`${Date.now()}-${random}`) — the whole point of this test is to catch schema/payload
  // mismatches that only a realistic ID shape would surface.
  const featureRunId = `${Date.now()}-run-${runCounter}`;
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
  return { featureRunId };
}

async function seedPullRequestRow(
  db: ReturnType<typeof createTestDb>,
  featureRunId: string,
  opts: { prNumber: number; ciStatus?: string; reviewState?: string },
): Promise<void> {
  await db.execute(
    `INSERT INTO pull_requests
       (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
        ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
     VALUES (?, ?, ?, 'minicoder/FR-001', 'main', 'sha1', 'open', ?, ?, '[]', 0, 1, datetime('now'), datetime('now'))`,
    [
      `pr-${featureRunId}`,
      featureRunId,
      opts.prNumber,
      opts.reviewState ?? 'none',
      opts.ciStatus ?? 'pending',
    ],
  );
}

function observed(overrides: Partial<ObservedPullRequestState> = {}): ObservedPullRequestState {
  return {
    prNumber: 20,
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

async function latestOutboxPayload(
  db: ReturnType<typeof createTestDb>,
  eventType: string,
): Promise<unknown> {
  const rows = await db.query<{ payload: string }>(
    `SELECT payload FROM outbox_events WHERE event_type = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [eventType],
  );
  expect(rows[0]).toBeDefined();
  return JSON.parse(rows[0]!.payload) as unknown;
}

describe('GitHub handler outbox payloads parse against their registered EVENT_SCHEMAS entry', () => {
  it('feature.pr_opened (RecordPrOpenedHandler)', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.CODE_PUSHED);
    const lockId = `lock-${featureRunId}`;
    await db.execute(
      `INSERT INTO workflow_locks (id, project_id, resource_key, holder_id, fence, expires_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
      [
        lockId,
        PROJECT_ID,
        `execution-lane:${PROJECT_ID}`,
        'test-holder',
        new Date(Date.now() + 60_000).toISOString(),
      ],
    );

    await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 21 }),
      correlationId: 'corr-schema-pr-opened',
      lockContext: {
        lockId,
        fence: 1,
        holderId: 'test-holder',
        projectId: PROJECT_ID,
        resourceKey: `execution-lane:${PROJECT_ID}`,
      },
    });

    const payload = await latestOutboxPayload(db, 'feature.pr_opened');
    expect(() => FeaturePrOpenedPayloadSchema.parse(payload)).not.toThrow();
  });

  it('feature.ci_running (RecordCiRunningHandler)', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.PR_OPENED);
    await seedPullRequestRow(db, featureRunId, { prNumber: 22 });
    const lockId = `lock-${featureRunId}`;
    await db.execute(
      `INSERT INTO workflow_locks (id, project_id, resource_key, holder_id, fence, expires_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
      [
        lockId,
        PROJECT_ID,
        `execution-lane:${PROJECT_ID}`,
        'test-holder',
        new Date(Date.now() + 60_000).toISOString(),
      ],
    );

    await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 22, ciStatus: 'running' }),
      correlationId: 'corr-schema-ci-running',
      lockContext: {
        lockId,
        fence: 1,
        holderId: 'test-holder',
        projectId: PROJECT_ID,
        resourceKey: `execution-lane:${PROJECT_ID}`,
      },
    });

    const payload = await latestOutboxPayload(db, 'feature.ci_running');
    expect(() => FeatureCiRunningPayloadSchema.parse(payload)).not.toThrow();
  });

  it('feature.ci_passed (RecordCiPassedHandler) includes conclusion: success', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.CI_RUNNING);
    await seedPullRequestRow(db, featureRunId, { prNumber: 23, ciStatus: 'running' });

    await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 23, ciStatus: 'passed' }),
      correlationId: 'corr-schema-ci-passed',
    });

    const payload = await latestOutboxPayload(db, 'feature.ci_passed');
    expect((payload as { conclusion: string }).conclusion).toBe('success');
    expect(() => FeatureCiResultPayloadSchema.parse(payload)).not.toThrow();
  });

  it('feature.ci_failed (RecordCiFailedHandler) includes conclusion: failure', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.CI_RUNNING);
    await seedPullRequestRow(db, featureRunId, { prNumber: 24, ciStatus: 'running' });

    await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 24, ciStatus: 'failed' }),
      correlationId: 'corr-schema-ci-failed',
    });

    const payload = await latestOutboxPayload(db, 'feature.ci_failed');
    expect((payload as { conclusion: string }).conclusion).toBe('failure');
    expect(() => FeatureCiResultPayloadSchema.parse(payload)).not.toThrow();
  });

  it('feature.changes_requested (RecordChangesRequestedHandler)', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.UNDER_REVIEW);
    await seedPullRequestRow(db, featureRunId, { prNumber: 25, ciStatus: 'passed' });

    await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 25, ciStatus: 'passed', reviewState: 'changes_requested' }),
      correlationId: 'corr-schema-changes-requested',
    });

    const payload = await latestOutboxPayload(db, 'feature.changes_requested');
    expect(() => FeatureChangesRequestedPayloadSchema.parse(payload)).not.toThrow();
  });

  it('feature.human_required (EscalateToHumanHandler)', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db, FeatureExecutionState.CI_RUNNING);
    await seedPullRequestRow(db, featureRunId, { prNumber: 26, ciStatus: 'running' });

    await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed: observed({ prNumber: 26, state: 'closed', mergedAt: null }),
      correlationId: 'corr-schema-human-required',
    });

    const payload = await latestOutboxPayload(db, 'feature.human_required');
    expect(() => FeatureHumanRequiredPayloadSchema.parse(payload)).not.toThrow();
  });
});
