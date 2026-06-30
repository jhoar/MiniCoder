import type { Scenario, ScenarioContext } from './types.js';

export const reviewLoopScenario: Scenario = {
  name: 'review-loop',
  description:
    'Coder (success) → reviewer (request_changes) → coder → reviewer (approve) → assert approved_by_policy',
  fixtureName: 'review-loop',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner, coder, reviewer } = ctx;

    const featureRun = await db.query<{ id: string; feature_request_id: string }>(
      `SELECT fr.id, fr.feature_request_id
       FROM feature_runs fr
       JOIN feature_requests freq ON fr.feature_request_id = freq.id
       WHERE freq.project_id = ?
       LIMIT 1`,
      [projectId],
    );

    if (!featureRun[0]) {
      throw new Error('No feature run found for review-loop scenario');
    }

    const { id: featureRunId, feature_request_id: featureRequestId } = featureRun[0];

    // Round 1: coder succeeds
    coder.behavior = 'success';
    await runner.run(
      'start-next-feature',
      { projectId, featureRunId },
      async (_payload: unknown) => {
        const result = await coder.run({
          projectId,
          featureRunId,
          featureTitle: 'API Endpoint',
          acceptanceCriteria: ['Implement the main API endpoint'],
          correlationId: `corr-coder-r1-${featureRunId}`,
        });
        await db.execute(
          `UPDATE feature_runs SET current_execution_state = 'under_review', updated_at = datetime('now')
           WHERE id = ?`,
          [featureRunId],
        );
        await db.execute(
          `UPDATE feature_requests SET state = 'under_review', updated_at = datetime('now')
           WHERE id = ?`,
          [featureRequestId],
        );
        return result;
      },
    );

    // Round 1: reviewer requests changes
    reviewer.behavior = 'request_changes';
    await runner.run(
      'github-reconciliation',
      { projectId, featureRunId, reviewCycle: 3 },
      async (_payload: unknown) => {
        const result = await reviewer.run({
          projectId,
          featureRunId,
          prNumber: 1,
          reviewCycle: 3,
          correlationId: `corr-review-r1-${featureRunId}`,
        });

        if (result.decision === 'changes_requested') {
          await db.execute(
            `UPDATE feature_runs SET current_execution_state = 'changes_requested', updated_at = datetime('now')
             WHERE id = ?`,
            [featureRunId],
          );
          await db.execute(
            `UPDATE feature_requests SET state = 'changes_requested', updated_at = datetime('now')
             WHERE id = ?`,
            [featureRequestId],
          );
        }

        return result;
      },
    );

    // Round 2: coder fixes
    await runner.run(
      'start-next-feature',
      { projectId, featureRunId },
      async (_payload: unknown) => {
        const result = await coder.run({
          projectId,
          featureRunId,
          featureTitle: 'API Endpoint',
          acceptanceCriteria: ['Implement the main API endpoint'],
          correlationId: `corr-coder-r2-${featureRunId}`,
        });
        await db.execute(
          `UPDATE feature_runs SET current_execution_state = 'under_review', updated_at = datetime('now')
           WHERE id = ?`,
          [featureRunId],
        );
        await db.execute(
          `UPDATE feature_requests SET state = 'under_review', updated_at = datetime('now')
           WHERE id = ?`,
          [featureRequestId],
        );
        return result;
      },
    );

    // Round 2: reviewer approves
    reviewer.behavior = 'approve';
    await runner.run(
      'github-reconciliation',
      { projectId, featureRunId, reviewCycle: 4 },
      async (_payload: unknown) => {
        const result = await reviewer.run({
          projectId,
          featureRunId,
          prNumber: 1,
          reviewCycle: 4,
          correlationId: `corr-review-r2-${featureRunId}`,
        });

        if (result.decision === 'approved') {
          await db.execute(
            `UPDATE feature_runs SET current_execution_state = 'approved_by_policy', updated_at = datetime('now')
             WHERE id = ?`,
            [featureRunId],
          );
          await db.execute(
            `UPDATE feature_requests SET state = 'approved_by_policy', updated_at = datetime('now')
             WHERE id = ?`,
            [featureRequestId],
          );
        }

        return result;
      },
    );

    const finalRun = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );

    if (finalRun[0]?.current_execution_state !== 'approved_by_policy') {
      throw new Error(
        `Expected feature_run state 'approved_by_policy', got '${finalRun[0]?.current_execution_state}'`,
      );
    }

    if (coder.calls.length !== 2) {
      throw new Error(`Expected 2 coder calls, got ${coder.calls.length}`);
    }
    if (reviewer.calls.length !== 2) {
      throw new Error(`Expected 2 reviewer calls, got ${reviewer.calls.length}`);
    }
  },
};
