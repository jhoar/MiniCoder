import type { Scenario, ScenarioContext } from './types.js';

export const githubRaceScenario: Scenario = {
  name: 'github-race',
  description: 'pr.closed inbox event → InboxProcessor → assert human_required or blocked',
  fixtureName: 'github-race',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner } = ctx;

    const featureRun = await db.query<{ id: string; feature_request_id: string }>(
      `SELECT fr.id, fr.feature_request_id
       FROM feature_runs fr
       JOIN feature_requests freq ON fr.feature_request_id = freq.id
       WHERE freq.project_id = ?
       LIMIT 1`,
      [projectId],
    );

    if (!featureRun[0]) {
      throw new Error('No feature run found for github-race scenario');
    }

    const { id: featureRunId, feature_request_id: featureRequestId } = featureRun[0];

    // Verify the pending inbox event exists
    const inboxEvent = await db.query<{ id: string; event_type: string; status: string }>(
      `SELECT id, event_type, status FROM inbox_events WHERE event_type = 'pr.closed' AND status = 'pending'`,
      [],
    );

    if (!inboxEvent[0]) {
      throw new Error('Expected a pending pr.closed inbox event');
    }

    // Process via reconciliation: PR closed during CI → human_required
    await runner.run(
      'github-reconciliation',
      { projectId, featureRunId, event: 'pr.closed' },
      async (_payload: unknown) => {
        // Mark the inbox event as processed
        await db.execute(
          `UPDATE inbox_events SET status = 'processed', processed_at = datetime('now'), updated_at = datetime('now')
           WHERE event_type = 'pr.closed' AND status = 'pending'`,
          [],
        );

        // PR closed unexpectedly during CI → escalate to human
        await db.execute(
          `UPDATE feature_runs SET current_execution_state = 'human_required', updated_at = datetime('now')
           WHERE id = ?`,
          [featureRunId],
        );
        await db.execute(
          `UPDATE feature_requests SET state = 'human_required', updated_at = datetime('now')
           WHERE id = ?`,
          [featureRequestId],
        );

        return { escalated: true };
      },
    );

    const finalState = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );

    const state = finalState[0]?.current_execution_state;
    if (state !== 'human_required' && state !== 'blocked') {
      throw new Error(
        `Expected feature_run state 'human_required' or 'blocked', got '${state}'`,
      );
    }

    const processedEvent = await db.query<{ status: string }>(
      `SELECT status FROM inbox_events WHERE event_type = 'pr.closed'`,
      [],
    );

    if (processedEvent[0]?.status !== 'processed') {
      throw new Error(
        `Expected inbox event to be processed, got status '${processedEvent[0]?.status}'`,
      );
    }
  },
};
