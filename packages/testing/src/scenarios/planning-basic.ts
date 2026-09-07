import {
  runPlanningReadinessAssessment,
  runGenerateImplementationPlan,
  runGenerateFeatureBacklog,
} from '@minicoder/triggerdev';
import type { Scenario, ScenarioContext } from './types.js';

export const planningBasicScenario: Scenario = {
  name: 'planning-basic',
  description: 'Runs planning-readiness-assessment and asserts no planning questions are created',
  fixtureName: 'planning-basic',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner, planner } = ctx;

    // Issue #100: AssessPlanningReadinessHandler previously wired no costExtractor at all, so
    // every readiness assessment recorded zero cost regardless of real token usage. Setting this
    // exercises that wiring end to end against a real cost_records write.
    planner.tokensUsed = { input: 100, output: 40 };

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

    const costRecords = await db.query<{ amount: number; scope: string }>(
      `SELECT amount, scope FROM cost_records WHERE project_id = ?`,
      [projectId],
    );
    if (costRecords.length !== 1) {
      throw new Error(
        `Expected exactly 1 cost_records row for the readiness-assessment run, found ${costRecords.length}`,
      );
    }
    if (!(costRecords[0]!.amount > 0)) {
      throw new Error(`Expected a positive cost amount, got ${costRecords[0]!.amount}`);
    }
    if (costRecords[0]!.scope !== 'project') {
      throw new Error(`Expected cost_records.scope='project', got '${costRecords[0]!.scope}'`);
    }

    // Issue #105: GenerateImplementationPlanHandler/GenerateFeatureBacklogHandler don't hard-gate
    // on unresolved blocking planning_gaps (submit-for-approval is the real gate), but they must
    // write a visible, durable workflow_events warning when generation proceeds anyway against an
    // assessment/plan with an unresolved blocking gap. The 'sufficient' MockPlannerAdapter behavior
    // reports no gaps, so a blocking gap is seeded directly here to simulate one raised (and left
    // unresolved) during an earlier clarification round.
    const assessmentRows = await db.query<{ id: string }>(
      `SELECT id FROM planning_readiness_assessments WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    const assessmentId = assessmentRows[0]!.id;
    const gapId = `gap-${projectId}`;
    await db.execute(
      `INSERT INTO planning_gaps
         (id, assessment_id, description, severity, resolution, resolved_at, clarification_session_id, version, created_at, updated_at)
       VALUES (?, ?, 'Missing non-functional requirements', 'blocking', NULL, NULL, NULL, 1, datetime('now'), datetime('now'))`,
      [gapId, assessmentId],
    );

    await runner.run(
      'generate-implementation-plan',
      {
        projectId,
        correlationId: `corr-planning-basic-plan-${projectId}`,
        idempotencyKey: `idem-planning-basic-plan-${projectId}`,
        assessmentId,
        title: 'Task Management Plan',
        sections: [{ title: 'Overview', content: 'A task management system.' }],
      },
      runGenerateImplementationPlan,
    );

    const planWarningEvents = await db.query<{ payload: string | null }>(
      `SELECT payload FROM workflow_events
       WHERE project_id = ? AND event_type = 'plan.generated_with_unresolved_blocking_gaps'`,
      [projectId],
    );
    if (planWarningEvents.length !== 1) {
      throw new Error(
        `Expected exactly 1 plan.generated_with_unresolved_blocking_gaps event, found ${planWarningEvents.length}`,
      );
    }
    const planWarningPayload: { unresolvedBlockingGapCount: number; gapIds: string[] } =
      JSON.parse(planWarningEvents[0]!.payload!);
    if (planWarningPayload.unresolvedBlockingGapCount !== 1) {
      throw new Error(
        `Expected unresolvedBlockingGapCount 1, got ${planWarningPayload.unresolvedBlockingGapCount}`,
      );
    }
    if (!planWarningPayload.gapIds.includes(gapId)) {
      throw new Error(`Expected warning payload gapIds to include ${gapId}`);
    }

    const planRows = await db.query<{ id: string }>(
      `SELECT id FROM implementation_plans WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    const planId = planRows[0]!.id;

    await runner.run(
      'generate-feature-backlog',
      {
        projectId,
        correlationId: `corr-planning-basic-backlog-${projectId}`,
        idempotencyKey: `idem-planning-basic-backlog-${projectId}`,
        planId,
        features: [
          {
            frId: 'FR-001',
            title: 'Create task',
            description: 'Allow creating a task.',
            kind: 'feature' as const,
            priority: 0,
            dependsOnFrIds: [],
            acceptanceCriteria: ['Task can be created.'],
            testExpectations: [{ description: 'Covered by unit tests.', testType: 'unit' as const }],
          },
        ],
      },
      runGenerateFeatureBacklog,
    );

    const backlogWarningEvents = await db.query<{ payload: string | null }>(
      `SELECT payload FROM workflow_events
       WHERE project_id = ? AND event_type = 'backlog.generated_with_unresolved_blocking_gaps'`,
      [projectId],
    );
    if (backlogWarningEvents.length !== 1) {
      throw new Error(
        `Expected exactly 1 backlog.generated_with_unresolved_blocking_gaps event, found ${backlogWarningEvents.length}`,
      );
    }
    const backlogWarningPayload: { unresolvedBlockingGapCount: number; gapIds: string[] } =
      JSON.parse(backlogWarningEvents[0]!.payload!);
    if (backlogWarningPayload.unresolvedBlockingGapCount !== 1) {
      throw new Error(
        `Expected backlog warning unresolvedBlockingGapCount 1, got ${backlogWarningPayload.unresolvedBlockingGapCount}`,
      );
    }
    if (!backlogWarningPayload.gapIds.includes(gapId)) {
      throw new Error(`Expected backlog warning payload gapIds to include ${gapId}`);
    }

    // Resolving the gap and regenerating must not emit another warning.
    await db.execute(
      `UPDATE planning_gaps SET resolved_at = datetime('now'), resolution = 'accepted', version = version + 1 WHERE id = ?`,
      [gapId],
    );
    await runner.run(
      'generate-implementation-plan',
      {
        projectId,
        correlationId: `corr-planning-basic-plan2-${projectId}`,
        idempotencyKey: `idem-planning-basic-plan2-${projectId}`,
        assessmentId,
        title: 'Task Management Plan Revised',
        sections: [{ title: 'Overview', content: 'A revised task management system.' }],
      },
      runGenerateImplementationPlan,
    );
    const planWarningEventsAfterResolve = await db.query<{ id: string }>(
      `SELECT id FROM workflow_events
       WHERE project_id = ? AND event_type = 'plan.generated_with_unresolved_blocking_gaps'`,
      [projectId],
    );
    if (planWarningEventsAfterResolve.length !== 1) {
      throw new Error(
        `Expected the warning event count to stay at 1 after resolving the gap and regenerating, found ${planWarningEventsAfterResolve.length}`,
      );
    }
  },
};
