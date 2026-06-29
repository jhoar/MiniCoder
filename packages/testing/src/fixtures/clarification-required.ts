import type { DbClient } from '@minicoder/core';
import type { Fixture } from './types.js';

export const clarificationRequiredFixture: Fixture = {
  name: 'clarification-required',
  description: 'Project with insufficient readiness assessment and 2 unanswered planning questions',

  async setup(db: DbClient, projectId = 'proj-clarif'): Promise<void> {
    const specId = `spec-${projectId}`;
    const assessId = `assess-${projectId}`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Clarification Required Project', 'Fixture for clarification-required scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO specification_inputs (id, project_id, content, content_type, version, created_at, updated_at)
       VALUES (?, ?, 'Build something awesome.', 'text/plain', 1, datetime('now'), datetime('now'))`,
      [specId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO planning_readiness_assessments (id, project_id, specification_input_id, status, summary, version, created_at, updated_at)
       VALUES (?, ?, ?, 'insufficient', 'Specification lacks detail; clarification needed before planning can proceed', 1, datetime('now'), datetime('now'))`,
      [assessId, projectId, specId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO planning_gaps (id, assessment_id, description, severity, version, created_at, updated_at)
       VALUES (?, ?, 'Missing non-functional requirements (performance, scalability)', 'blocking', 1, datetime('now'), datetime('now'))`,
      [`gap-${projectId}-1`, assessId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO planning_questions (id, assessment_id, question, answer, round, version, created_at, updated_at)
       VALUES (?, ?, 'What is the expected user volume?', NULL, 1, 1, datetime('now'), datetime('now'))`,
      [`q-${projectId}-1`, assessId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO planning_questions (id, assessment_id, question, answer, round, version, created_at, updated_at)
       VALUES (?, ?, 'What authentication method should be used?', NULL, 1, 1, datetime('now'), datetime('now'))`,
      [`q-${projectId}-2`, assessId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId],
    );
  },
};
