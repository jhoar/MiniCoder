import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import { generateId } from '@minicoder/core';
import type { DbClient } from '@minicoder/core';
import { resolveReviewFinding } from './review-finding-resolution.js';
import { NotFoundError } from '../errors.js';

async function seedFindingChain(
  db: DbClient,
  projectId: string,
  opts: { resolved?: boolean } = {},
): Promise<{ featureRunId: string; findingId: string }> {
  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
    [projectId],
  );
  const planId = generateId();
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
    [planId, projectId],
  );
  const featureRequestId = generateId();
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'T', 'D', 'feature', 1, 'under_review', 0, 1, datetime('now'), datetime('now'))`,
    [featureRequestId, planId, projectId],
  );
  const featureRunId = generateId();
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
     VALUES (?, ?, 1, 'under_review', 1, datetime('now'), datetime('now'))`,
    [featureRunId, featureRequestId],
  );
  const findingId = generateId();
  await db.execute(
    `INSERT INTO review_findings (id, feature_run_id, reviewer_run_id, review_cycle, severity, category, description, resolved, version, created_at, updated_at)
     VALUES (?, ?, NULL, 1, 'non_blocking', 'style', 'A non-blocking finding', ?, 1, datetime('now'), datetime('now'))`,
    [findingId, featureRunId, opts.resolved ? 1 : 0],
  );
  return { featureRunId, findingId };
}

describe('resolveReviewFinding (issue #116)', () => {
  it('records a "deferred" disposition without touching resolved when --dismiss is not passed', async () => {
    const db = createTestDb() as unknown as DbClient;
    const { findingId } = await seedFindingChain(db, 'proj-finding-1');

    const result = await resolveReviewFinding(db, {
      findingId,
      dismiss: false,
      note: 'Still want this fixed eventually',
      actorId: 'test-operator',
      actorRole: 'operator',
    });

    expect(result).toEqual({ findingId, dismissed: false, alreadyResolved: false });

    const rows = await db.query<{ resolved: number }>(
      `SELECT resolved FROM review_findings WHERE id = ?`,
      [findingId],
    );
    expect(Boolean(rows[0]?.resolved)).toBe(false);

    const approvals = await db.query<{ decision: string; context_id: string }>(
      `SELECT decision, context_id FROM human_approvals WHERE context_type = 'review_finding_disposition' AND context_id = ?`,
      [findingId],
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.decision).toBe('deferred');
  });

  it('records an "approved" disposition and flips resolved to true when --dismiss is passed', async () => {
    const db = createTestDb() as unknown as DbClient;
    const { findingId } = await seedFindingChain(db, 'proj-finding-2');

    const result = await resolveReviewFinding(db, {
      findingId,
      dismiss: true,
      actorId: 'test-operator',
      actorRole: 'operator',
    });

    expect(result).toEqual({ findingId, dismissed: true, alreadyResolved: false });

    const rows = await db.query<{ resolved: number }>(
      `SELECT resolved FROM review_findings WHERE id = ?`,
      [findingId],
    );
    expect(Boolean(rows[0]?.resolved)).toBe(true);

    const approvals = await db.query<{ decision: string }>(
      `SELECT decision FROM human_approvals WHERE context_type = 'review_finding_disposition' AND context_id = ?`,
      [findingId],
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.decision).toBe('approved');
  });

  it('is idempotent: dismissing an already-resolved finding reports alreadyResolved without erroring', async () => {
    const db = createTestDb() as unknown as DbClient;
    const { findingId } = await seedFindingChain(db, 'proj-finding-3', { resolved: true });

    const result = await resolveReviewFinding(db, {
      findingId,
      dismiss: true,
      actorId: 'test-operator',
      actorRole: 'operator',
    });

    expect(result).toEqual({ findingId, dismissed: true, alreadyResolved: true });
  });

  it('writes an audit workflow_events row scoped to the feature run', async () => {
    const db = createTestDb() as unknown as DbClient;
    const { featureRunId, findingId } = await seedFindingChain(db, 'proj-finding-4');

    await resolveReviewFinding(db, {
      findingId,
      dismiss: true,
      note: 'not worth fixing',
      actorId: 'test-operator',
      actorRole: 'operator',
    });

    const events = await db.query<{ payload: string }>(
      `SELECT payload FROM workflow_events WHERE feature_run_id = ? AND event_type = 'review_finding.disposition_recorded'`,
      [featureRunId],
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toEqual({
      findingId,
      dismiss: true,
      note: 'not worth fixing',
    });
  });

  it('rejects an unknown findingId', async () => {
    const db = createTestDb() as unknown as DbClient;

    await expect(
      resolveReviewFinding(db, {
        findingId: 'does-not-exist',
        dismiss: false,
        actorId: 'test-operator',
        actorRole: 'operator',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
