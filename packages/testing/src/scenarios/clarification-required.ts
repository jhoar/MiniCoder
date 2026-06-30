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

    await runner.run('planning-readiness-assessment', { projectId }, async (_payload: unknown) => {
      const result = await planner.run({
        projectId,
        specificationContent: 'Build something awesome.',
        correlationId: `corr-clarification-${projectId}`,
      });
      return result;
    });

    await runner.run('start-clarification', { projectId }, async (_payload: unknown) => {
      // Simulate clarification task: ensure unanswered questions remain
      return { started: true };
    });

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

    const assessment = await db.query<{ status: string }>(
      `SELECT status FROM planning_readiness_assessments WHERE project_id = ?`,
      [projectId],
    );

    if (assessment[0]?.status !== 'insufficient') {
      throw new Error(`Expected assessment status 'insufficient', got '${assessment[0]?.status}'`);
    }
  },
};
