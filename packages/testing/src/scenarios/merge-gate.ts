import type { Scenario, ScenarioContext } from './types.js';

export const mergeGateScenario: Scenario = {
  name: 'merge-gate',
  description: 'simulateCheckPassed → simulatePrMerged → assert feature merged',
  fixtureName: 'merge-gate',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner, github } = ctx;

    const featureRun = await db.query<{ id: string; feature_request_id: string }>(
      `SELECT fr.id, fr.feature_request_id
       FROM feature_runs fr
       JOIN feature_requests freq ON fr.feature_request_id = freq.id
       WHERE freq.project_id = ?
       LIMIT 1`,
      [projectId],
    );

    if (!featureRun[0]) {
      throw new Error('No feature run found for merge-gate scenario');
    }

    const { id: featureRunId, feature_request_id: featureRequestId } = featureRun[0];
    const prNumber = 99;

    // Register the PR before any other simulate calls require it
    github.simulatePrOpened(prNumber, featureRunId, 'initial-sha');

    // Simulate CI check passed
    github.simulateCheckPassed(prNumber, 'ci/test');
    const prStateAfterCheck = github.getPrState(prNumber);

    if (!prStateAfterCheck?.checks.some((c) => c.id === 'ci/test' && c.state === 'passed')) {
      throw new Error('Expected CI check to be recorded after simulateCheckPassed');
    }

    // Simulate PR merged
    github.simulatePrMerged(prNumber, 'abc123def456');
    const prStateAfterMerge = github.getPrState(prNumber);

    if (prStateAfterMerge?.state !== 'merged') {
      throw new Error('Expected PR to be marked merged after simulatePrMerged');
    }

    // Process the merge event via reconciliation task
    await runner.run(
      'github-reconciliation',
      { projectId, featureRunId, prNumber, event: 'pr.merged' },
      async (_payload: unknown) => {
        await db.execute(
          `UPDATE feature_runs SET current_execution_state = 'merged', ended_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`,
          [featureRunId],
        );
        await db.execute(
          `UPDATE feature_requests SET state = 'merged', updated_at = datetime('now')
           WHERE id = ?`,
          [featureRequestId],
        );
        return { merged: true };
      },
    );

    const finalState = await db.query<{ current_execution_state: string; state: string }>(
      `SELECT fr.current_execution_state, freq.state
       FROM feature_runs fr
       JOIN feature_requests freq ON fr.feature_request_id = freq.id
       WHERE fr.id = ?`,
      [featureRunId],
    );

    if (finalState[0]?.current_execution_state !== 'merged') {
      throw new Error(
        `Expected feature_run state 'merged', got '${finalState[0]?.current_execution_state}'`,
      );
    }

    if (finalState[0]?.state !== 'merged') {
      throw new Error(`Expected feature_request state 'merged', got '${finalState[0]?.state}'`);
    }
  },
};
