import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import type { DbClient } from '@minicoder/core';
import { getPlanningReadinessAssessment } from './planning.js';

/**
 * Previously `getPlanningReadinessAssessment()` returned only the bare
 * `planning_readiness_assessments` row — the gaps/assumptions/questions it produced were
 * genuinely invisible to any API/CLI/Web UI caller, reachable only via a raw SQL query against
 * the database. This proves the read-model now surfaces all three, scoped to the right
 * assessment (a second, unrelated assessment's rows must never leak in).
 */

const PROJECT_ID = 'proj-planning-readiness-detail';

async function seedAssessment(
  db: DbClient,
  assessmentId: string,
  specInputId: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO specification_inputs (id, project_id, content, version, created_at, updated_at)
     VALUES (?, ?, 'spec content', 1, datetime('now'), datetime('now'))`,
    [specInputId, PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO planning_readiness_assessments (id, project_id, specification_input_id, status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'sufficient_with_assumptions', 1, datetime('now'), datetime('now'))`,
    [assessmentId, PROJECT_ID, specInputId],
  );
}

describe('getPlanningReadinessAssessment (detail)', () => {
  it('returns gaps, assumptions, and questions scoped to the requested assessment only', async () => {
    const db = createTestDb();
    await db.execute(`INSERT INTO projects (id, name) VALUES (?, ?)`, [PROJECT_ID, 'Test']);
    await seedAssessment(db, 'assessment-1', 'spec-1');
    await seedAssessment(db, 'assessment-2', 'spec-2');

    await db.execute(
      `INSERT INTO planning_gaps (id, assessment_id, description, severity, version, created_at, updated_at)
       VALUES (?, ?, 'No tech stack specified', 'non_blocking', 1, datetime('now'), datetime('now'))`,
      ['gap-1', 'assessment-1'],
    );
    await db.execute(
      `INSERT INTO planning_assumptions (id, assessment_id, description, confidence, version, created_at, updated_at)
       VALUES (?, ?, 'Single-user, no auth', 'high', 1, datetime('now'), datetime('now'))`,
      ['assumption-1', 'assessment-1'],
    );
    await db.execute(
      `INSERT INTO planning_questions (id, assessment_id, question, round, version, created_at, updated_at)
       VALUES (?, ?, 'What framework should be used?', 1, 1, datetime('now'), datetime('now'))`,
      ['question-1', 'assessment-1'],
    );
    // Rows for the OTHER assessment — must never appear in assessment-1's detail.
    await db.execute(
      `INSERT INTO planning_gaps (id, assessment_id, description, severity, version, created_at, updated_at)
       VALUES (?, ?, 'Unrelated gap', 'non_blocking', 1, datetime('now'), datetime('now'))`,
      ['gap-2', 'assessment-2'],
    );

    const detail = await getPlanningReadinessAssessment(db, 'assessment-1');

    expect(detail.assessment.id).toBe('assessment-1');
    expect(detail.gaps).toHaveLength(1);
    expect(detail.gaps[0]).toMatchObject({ description: 'No tech stack specified' });
    expect(detail.assumptions).toHaveLength(1);
    expect(detail.assumptions[0]).toMatchObject({ description: 'Single-user, no auth' });
    expect(detail.questions).toHaveLength(1);
    expect(detail.questions[0]).toMatchObject({ question: 'What framework should be used?' });
  });
});
