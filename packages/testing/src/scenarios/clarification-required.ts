import { runPlanningReadinessAssessment, runStartClarification } from '@minicoder/triggerdev';
import type { Scenario, ScenarioContext } from './types.js';

export const clarificationRequiredScenario: Scenario = {
  name: 'clarification-required',
  description:
    'Runs readiness assessment (insufficient) and start-clarification, asserts questions in DB',
  fixtureName: 'clarification-required',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner, planner } = ctx;

    // Override planner behavior to return insufficient
    planner.behavior = 'insufficient';

    await runner.run(
      'planning-readiness-assessment',
      {
        projectId,
        correlationId: `corr-clarification-${projectId}`,
        idempotencyKey: `idem-clarification-assess-${projectId}`,
        specificationContent: 'Build something awesome.',
        plannerAdapterName: 'MockPlannerAdapter',
      },
      runPlanningReadinessAssessment,
      undefined,
      planner,
    );

    const assessment = await db.query<{ status: string }>(
      `SELECT status FROM planning_readiness_assessments WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    if (assessment[0]?.status !== 'insufficient') {
      throw new Error(`Expected assessment status 'insufficient', got '${assessment[0]?.status}'`);
    }

    const session = await db.query<{ id: string; version: number }>(
      `SELECT id, version FROM clarification_sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    if (!session[0]) {
      throw new Error('Expected a clarification_sessions row to be created');
    }

    await runner.run(
      'start-clarification',
      {
        projectId,
        correlationId: `corr-clarification-start-${projectId}`,
        idempotencyKey: `idem-clarification-start-${projectId}`,
        actorId: 'test-operator',
        actorRole: 'operator' as const,
        clarificationSessionId: session[0].id,
        expectedVersion: session[0].version,
      },
      runStartClarification,
    );

    const questions = await db.query<{ id: string; answer: string | null }>(
      `SELECT pq.id, pq.answer FROM planning_questions pq
       JOIN planning_readiness_assessments pra ON pq.assessment_id = pra.id
       WHERE pra.project_id = ? AND pq.answer IS NULL`,
      [projectId],
    );

    if (questions.length < 1) {
      throw new Error(
        `Expected at least 1 unanswered planning question, found ${questions.length}`,
      );
    }

    const clarificationQuestions = await db.query<{ id: string }>(
      `SELECT id FROM clarification_questions WHERE clarification_session_id = ?`,
      [session[0].id],
    );
    if (clarificationQuestions.length < 1) {
      throw new Error('Expected clarification_questions to be created for the round');
    }
  },
};
