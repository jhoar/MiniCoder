import type { Scenario, ScenarioContext } from './types.js';

export const triggerRetryScenario: Scenario = {
  name: 'trigger-retry',
  description: 'Fail on first attempt, replay same runId, assert succeeded (idempotent)',
  fixtureName: 'trigger-retry',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner, coder } = ctx;

    const featureRun = await db.query<{ id: string; feature_request_id: string }>(
      `SELECT fr.id, fr.feature_request_id
       FROM feature_runs fr
       JOIN feature_requests freq ON fr.feature_request_id = freq.id
       WHERE freq.project_id = ?
       LIMIT 1`,
      [projectId],
    );

    if (!featureRun[0]) {
      throw new Error('No feature run found for trigger-retry scenario');
    }

    const { id: featureRunId, feature_request_id: featureRequestId } = featureRun[0];
    const idempotentRunId = `tdv2-${projectId}-run-001`;

    // First attempt: fail
    coder.behavior = 'fail';
    let firstAttemptFailed = false;
    try {
      await runner.run(
        'start-next-feature',
        { projectId, featureRunId },
        async (_payload: unknown) => {
          await coder.run({
            projectId,
            featureRunId,
            featureTitle: 'Retryable Feature',
            acceptanceCriteria: ['Feature to test idempotent retry'],
            correlationId: `corr-retry-attempt1-${featureRunId}`,
          });
        },
        idempotentRunId,
      );
    } catch {
      firstAttemptFailed = true;
    }

    if (!firstAttemptFailed) {
      throw new Error('Expected first attempt to fail');
    }

    // Second attempt: same runId, coder now succeeds
    coder.behavior = 'success';
    await runner.run(
      'start-next-feature',
      { projectId, featureRunId },
      async (_payload: unknown) => {
        const result = await coder.run({
          projectId,
          featureRunId,
          featureTitle: 'Retryable Feature',
          acceptanceCriteria: ['Feature to test idempotent retry'],
          correlationId: `corr-retry-attempt2-${featureRunId}`,
        });
        await db.execute(
          `UPDATE feature_runs SET current_execution_state = 'code_pushed', updated_at = datetime('now')
           WHERE id = ?`,
          [featureRunId],
        );
        await db.execute(
          `UPDATE feature_requests SET state = 'code_pushed', updated_at = datetime('now')
           WHERE id = ?`,
          [featureRequestId],
        );
        return result;
      },
      idempotentRunId,
    );

    const triggerRun = await db.query<{ triggerdev_status: string }>(
      `SELECT triggerdev_status FROM triggerdev_runs WHERE triggerdev_run_id = ?`,
      [idempotentRunId],
    );

    if (triggerRun[0]?.triggerdev_status !== 'succeeded') {
      throw new Error(
        `Expected triggerdev_run status 'succeeded', got '${triggerRun[0]?.triggerdev_status}'`,
      );
    }

    // Total coder calls: 2 (one fail, one success)
    if (coder.calls.length < 2) {
      throw new Error(
        `Expected at least 2 coder calls (fail + success), got ${coder.calls.length}`,
      );
    }
  },
};
