import { describe, it, expect } from 'vitest';
import {
  insertReviewFindings,
  RecordCodePushedHandler,
  OptimisticLockError,
  FeatureExecutionState,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, RecordCodePushedPayload } from '@minicoder/core';
import { ExecutionLane } from '@minicoder/workflow';
import { createTestDb, insertTestProject } from './test-helpers.js';
import { systemActor } from './tasks/actor.js';

const PROJECT_ID = 'proj-write-findings-001';

describe('insertReviewFindings idempotent retry (Phase 10)', () => {
  it('inserting the same findings twice produces only one set of rows', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES ('plan-1', ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
      [PROJECT_ID],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES ('fr-1', 'plan-1', ?, 'FR-001', 'T', 'D', 'feature', 1, 'under_review', 0, 1, datetime('now'), datetime('now'))`,
      [PROJECT_ID],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES ('run-1', 'fr-1', 1, 'under_review', 1, datetime('now'), datetime('now'))`,
    );

    const findings = [
      { severity: 'blocking' as const, category: 'correctness', description: 'bug 1' },
      { severity: 'non_blocking' as const, category: 'style', description: 'nit 1' },
    ];

    await insertReviewFindings(db, {
      featureRunId: 'run-1',
      reviewerRunId: null,
      reviewCycle: 1,
      findings,
    });
    await insertReviewFindings(db, {
      featureRunId: 'run-1',
      reviewerRunId: null,
      reviewCycle: 1,
      findings,
    });

    const rows = await db.query<{ id: string }>(
      `SELECT id FROM review_findings WHERE feature_run_id = ?`,
      ['run-1'],
    );
    expect(rows).toHaveLength(2);
  });
});

describe('HIGH-2 code-review fix (round 2): RecordCodePushedHandler writes finding resolution atomically with the state transition', () => {
  it('a guard failure (stale expectedVersion) leaves no coder_responses row and the finding unresolved', async () => {
    const db = createTestDb();
    const projectId = 'proj-atomicity-001';
    insertTestProject(db, projectId);

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES ('plan-atomicity', ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES ('fr-atomicity', 'plan-atomicity', ?, 'FR-001', 'T', 'D', 'feature', 1, 'fixing', 0, 1, datetime('now'), datetime('now'))`,
      [projectId],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES ('run-atomicity', 'fr-atomicity', 1, 'fixing', 1, datetime('now'), datetime('now'))`,
    );
    await db.execute(
      `INSERT OR IGNORE INTO review_findings (id, feature_run_id, review_cycle, severity, category, description, resolved, version, created_at, updated_at)
       VALUES ('finding-atomicity-1', 'run-atomicity', 1, 'blocking', 'correctness', 'bug', 0, 1, datetime('now'), datetime('now'))`,
    );

    const lane = new ExecutionLane(db);
    const lock = await lane.acquireForProject(projectId, 'test-holder', 30_000);
    const handler = new RecordCodePushedHandler();
    const correlationId = 'corr-atomicity';

    const envelope: CommandEnvelope<RecordCodePushedPayload> = {
      commandId: generateId(),
      idempotencyKey: `record-code-pushed:run-atomicity:sha-1`,
      payload: {
        featureRunId: 'run-atomicity',
        projectId,
        // Deliberately stale — the real version is 1 — to force assertVersion to throw before
        // any write happens, proving the finding-resolution write never runs independently of the
        // state transition succeeding.
        expectedVersion: 99,
        commitSha: 'sha-1',
        branchName: 'minicoder/x',
        filesChanged: 1,
        coderRunId: 'agent-run-1',
        resolvedFindingIds: ['finding-atomicity-1'],
      },
      actor: systemActor(correlationId),
      correlationId,
      lockContext: {
        lockId: lock.lockId,
        fence: lock.fence,
        holderId: lock.holderId,
        projectId,
        resourceKey: lock.resourceKey,
      },
    };

    await expect(handler.execute(envelope, db)).rejects.toBeInstanceOf(OptimisticLockError);

    const responses = await db.query<{ id: string }>(
      `SELECT id FROM coder_responses WHERE finding_id = 'finding-atomicity-1'`,
    );
    expect(responses).toHaveLength(0);

    const findingRows = await db.query<{ resolved: number; current_execution_state?: string }>(
      `SELECT resolved FROM review_findings WHERE id = 'finding-atomicity-1'`,
    );
    expect(findingRows[0]?.resolved).toBe(0);

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = 'run-atomicity'`,
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.FIXING);
  });
});
