import { runPlanningReadinessAssessment } from '@minicoder/triggerdev';
import type { Scenario, ScenarioContext } from './types.js';

export const planningBasicScenario: Scenario = {
  name: 'planning-basic',
  description: 'Runs planning-readiness-assessment and asserts no planning questions are created',
  fixtureName: 'planning-basic',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner, planner } = ctx;

    const { result } = await runner.run(
      'planning-readiness-assessment',
      {
        projectId,
        correlationId: `corr-planning-basic-${projectId}`,
        idempotencyKey: `idem-planning-basic-${projectId}`,
        specificationContent: 'Build a task management system with projects and assignments.',
        plannerAdapterName: 'MockPlannerAdapter',
      },
      runPlanningReadinessAssessment,
      undefined,
      planner,
    );

    if (result.readinessResult !== 'sufficient') {
      throw new Error(`Expected readinessResult 'sufficient', got '${result.readinessResult}'`);
    }

    const questions = await db.query<{ id: string }>(
      `SELECT id FROM planning_questions
       WHERE assessment_id IN (SELECT id FROM planning_readiness_assessments WHERE project_id = ?)
         AND answer IS NULL`,
      [projectId],
    );

    if (questions.length > 0) {
      throw new Error(`Expected 0 unanswered planning questions, found ${questions.length}`);
    }

    if (planner.calls.length !== 1) {
      throw new Error(`Expected 1 planner call, got ${planner.calls.length}`);
    }
  },
};
