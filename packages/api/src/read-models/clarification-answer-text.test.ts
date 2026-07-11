import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import type { DbClient } from '@minicoder/core';
import { getClarificationSession } from './planning.js';

/**
 * Post-merge PR review fix (MEDIUM-5): `ClarificationQuestionRow` gained an additive
 * `answer_text` column (a `LEFT JOIN clarification_answers`) so the Web UI can render the real
 * answer instead of a static "Answered" label. This is the regression the reviewer's follow-up
 * asked for — a bare Zod/TS shape check wouldn't catch a query that silently dropped the join.
 */

const PROJECT_ID = 'proj-clarification-answer-text';

async function seedSession(db: DbClient): Promise<{ sessionId: string; questionIds: string[] }> {
  const sessionId = `session-${PROJECT_ID}`;
  const answeredQuestionId = `q-answered-${PROJECT_ID}`;
  const unansweredQuestionId = `q-unanswered-${PROJECT_ID}`;

  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO clarification_sessions (id, project_id, status, round, max_rounds, version, created_at, updated_at)
     VALUES (?, ?, 'in_progress', 1, 3, 1, datetime('now'), datetime('now'))`,
    [sessionId, PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO clarification_questions (id, clarification_session_id, question, round, order_index, asked_at, answered_at, version, created_at, updated_at)
     VALUES (?, ?, 'What auth model should we use?', 1, 0, datetime('now'), datetime('now'), 2, datetime('now'), datetime('now'))`,
    [answeredQuestionId, sessionId],
  );
  await db.execute(
    `INSERT INTO clarification_answers (id, clarification_question_id, answer, actor, actor_role, version, created_at, updated_at)
     VALUES (?, ?, 'Use static API keys with role-based access.', 'jhoar', 'approver', 1, datetime('now'), datetime('now'))`,
    [`answer-${PROJECT_ID}`, answeredQuestionId],
  );
  await db.execute(
    `INSERT INTO clarification_questions (id, clarification_session_id, question, round, order_index, asked_at, answered_at, version, created_at, updated_at)
     VALUES (?, ?, 'Which database should be the default?', 1, 1, datetime('now'), NULL, 1, datetime('now'), datetime('now'))`,
    [unansweredQuestionId, sessionId],
  );

  return { sessionId, questionIds: [answeredQuestionId, unansweredQuestionId] };
}

describe('getClarificationSession answer_text', () => {
  it('returns the real answer text for an answered question and null for an unanswered one', async () => {
    const db = createTestDb();
    const { sessionId } = await seedSession(db);

    const { questions } = await getClarificationSession(db, sessionId);

    const answered = questions.find((q) => q.answered_at !== null);
    const unanswered = questions.find((q) => q.answered_at === null);

    expect(answered?.answer_text).toBe('Use static API keys with role-based access.');
    expect(unanswered?.answer_text).toBeNull();
  });
});
