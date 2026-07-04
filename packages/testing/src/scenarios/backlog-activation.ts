import { runActivateApprovedBacklog } from '@minicoder/triggerdev';
import { EVENT_SCHEMAS } from '@minicoder/core';
import type { Scenario, ScenarioContext } from './types.js';

export const backlogActivationScenario: Scenario = {
  name: 'backlog-activation',
  description:
    'Runs activate-approved-backlog against a fixture-seeded approved plan, asserting feature_runs are created at approved_pending_execution',
  fixtureName: 'backlog-activation',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner } = ctx;

    const plans = await db.query<{ id: string; version: number }>(
      `SELECT id, version FROM implementation_plans WHERE project_id = ?`,
      [projectId],
    );
    const plan = plans[0];
    if (!plan) {
      throw new Error(`Expected an implementation_plans row for project ${projectId}`);
    }

    await runner.run(
      'activate-approved-backlog',
      {
        projectId,
        correlationId: `corr-backlog-activation-${projectId}`,
        idempotencyKey: `idem-backlog-activation-${projectId}`,
        actorId: 'test-approver',
        actorRole: 'approver' as const,
        planId: plan.id,
        expectedVersion: plan.version,
      },
      runActivateApprovedBacklog,
    );

    const features = await db.query<{ id: string }>(
      `SELECT id, state FROM feature_requests WHERE project_id = ? AND kind = 'feature'`,
      [projectId],
    );

    if (features.length !== 3) {
      throw new Error(`Expected 3 features, found ${features.length}`);
    }

    const featureRuns = await db.query<{
      feature_request_id: string;
      current_execution_state: string;
    }>(
      `SELECT fr.feature_request_id, fr.current_execution_state
       FROM feature_runs fr
       JOIN feature_requests freq ON fr.feature_request_id = freq.id
       WHERE freq.project_id = ?`,
      [projectId],
    );

    if (featureRuns.length !== 3) {
      throw new Error(`Expected 3 feature_runs rows, found ${featureRuns.length}`);
    }

    const notPending = featureRuns.filter(
      (r) => r.current_execution_state !== 'approved_pending_execution',
    );
    if (notPending.length > 0) {
      throw new Error(
        `Expected all feature_runs at approved_pending_execution, but ${notPending.length} are not`,
      );
    }

    // HIGH-1 code-review fix (round 3): validate the actual emitted plan.activated outbox
    // payload against its registered schema, rather than a hand-built payload — this is exactly
    // how the round-2 fix missed that ActivatePlanHandler emits `activatedFeatureCount`, not the
    // schema's then-`featureRequestCount`.
    const outboxRows = await db.query<{ payload: string }>(
      `SELECT payload FROM outbox_events WHERE event_type = 'plan.activated' ORDER BY created_at DESC LIMIT 1`,
    );
    if (outboxRows.length !== 1) {
      throw new Error(`Expected exactly 1 plan.activated outbox row, found ${outboxRows.length}`);
    }
    const payload: unknown = JSON.parse(outboxRows[0]!.payload);
    EVENT_SCHEMAS['plan.activated']!.parse(payload);
  },
};
