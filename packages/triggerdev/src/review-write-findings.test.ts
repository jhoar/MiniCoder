import { describe, it, expect } from 'vitest';
import { insertReviewFindings } from '@minicoder/core';
import { createTestDb, insertTestProject } from './test-helpers.js';

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
