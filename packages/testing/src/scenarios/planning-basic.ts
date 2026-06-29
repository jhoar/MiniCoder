import type { Scenario, ScenarioContext } from './types.js';

export const planningBasicScenario: Scenario = {
  name: 'planning-basic',
  description: 'Runs planning-readiness-assessment and asserts no planning questions are created',
  fixtureName: 'planning-basic',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner, planner } = ctx;

    await runner.run(
      'planning-readiness-assessment',
      { projectId },
      async (_payload: unknown) => {
        const result = await planner.run({
          projectId,
          specificationContent: 'Build a task management system with projects and assignments.',
          correlationId: `corr-planning-basic-${projectId}`,
        });

        if (result.readinessResult === 'sufficient') {
          // No questions means assessment is sufficient — update assessment
          await db.execute(
            `UPDATE planning_readiness_assessments SET status = 'sufficient', updated_at = datetime('now')
             WHERE project_id = ?`,
            [projectId],
          );
        }

        return result;
      },
    );

    const questions = await db.query<{ id: string }>(
      `SELECT id FROM planning_questions
       WHERE assessment_id IN (SELECT id FROM planning_readiness_assessments WHERE project_id = ?)
         AND answer IS NULL`,
      [projectId],
    );

    if (questions.length > 0) {
      throw new Error(
        `Expected 0 unanswered planning questions, found ${questions.length}`,
      );
    }

    if (planner.calls.length !== 1) {
      throw new Error(`Expected 1 planner call, got ${planner.calls.length}`);
    }
  },
};
