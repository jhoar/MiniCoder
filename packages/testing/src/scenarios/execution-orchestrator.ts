import {
  ApproveBudgetOverrideHandler,
  TransactionalCommandExecutor,
  applyBudgetDecision,
  evaluateBudget,
  generateId,
} from '@minicoder/core';
import type { ActorIdentity, CommandEnvelope } from '@minicoder/core';
import { runStartNextFeature } from '@minicoder/triggerdev';
import type { Scenario, ScenarioContext } from './types.js';

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
}

interface WorkflowStateRow {
  automation_state: string;
  version: number;
}

const approveOverrideHandler = new ApproveBudgetOverrideHandler();

function systemActor(correlationId: string): ActorIdentity {
  return { id: 'scenario-system', role: 'admin', actorKind: 'system', correlationId };
}

function approverActor(correlationId: string): ActorIdentity {
  return { id: 'scenario-approver', role: 'approver', actorKind: 'human', correlationId };
}

async function getFeatureRunByFrId(ctx: ScenarioContext, frSuffix: string): Promise<FeatureRunRow> {
  const rows = await ctx.db.query<FeatureRunRow>(
    `SELECT fr.id, fr.current_execution_state
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE freq.project_id = ? AND freq.fr_id = ?`,
    [ctx.projectId, frSuffix],
  );
  const row = rows[0];
  if (!row) throw new Error(`No feature run found for ${frSuffix}`);
  return row;
}

async function getWorkflowState(ctx: ScenarioContext): Promise<WorkflowStateRow> {
  const rows = await ctx.db.query<WorkflowStateRow>(
    `SELECT automation_state, version FROM workflow_states WHERE project_id = ?`,
    [ctx.projectId],
  );
  const row = rows[0];
  if (!row) throw new Error('No workflow_states row found');
  return row;
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export const executionOrchestratorScenario: Scenario = {
  name: 'execution-orchestrator',
  description:
    'Dependency-ordered feature selection via start-next-feature, single-active-feature enforcement, and the budget-gate primitive (soft breach -> waiting_for_budget_approval, hard breach -> paused_budget_exceeded, override -> running)',
  fixtureName: 'execution-orchestrator',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner } = ctx;
    const correlationId = `corr-execution-orchestrator-${projectId}`;

    const fr1Before = await getFeatureRunByFrId(ctx, 'FR-001');

    // 1. start-next-feature should pick FR-001 (no dependencies) over FR-002 (depends on FR-001).
    const firstRun = await runner.run(
      'start-next-feature',
      { projectId, correlationId, idempotencyKey: `idem-snf-1-${projectId}` },
      runStartNextFeature,
    );
    assertEqual('first start-next-feature started', firstRun.result.started, true);
    assertEqual(
      'first start-next-feature selects FR-001',
      firstRun.result.featureRunId,
      fr1Before.id,
    );

    const fr1After = await db.query<FeatureRunRow>(
      `SELECT id, current_execution_state FROM feature_runs WHERE id = ?`,
      [fr1Before.id],
    );
    assertEqual('FR-001 reaches coding', fr1After[0]?.current_execution_state, 'coding');

    // 2. FR-002 is still dependency-blocked (FR-001 not yet merged) and FR-001 is no longer
    // approved_pending_execution — no eligible candidate, so the task is a clean no-op.
    const secondRun = await runner.run(
      'start-next-feature',
      { projectId, correlationId, idempotencyKey: `idem-snf-2-${projectId}` },
      runStartNextFeature,
    );
    assertEqual('second start-next-feature finds no candidate', secondRun.result.started, false);
    assertEqual(
      'second start-next-feature featureRunId is null',
      secondRun.result.featureRunId,
      null,
    );

    // 3. Soft budget breach on FR-001's feature-scoped policy (soft_limit=50, hard_limit=100).
    await db.execute(
      `INSERT INTO cost_records (id, project_id, feature_request_id, scope, amount, currency, recorded_at, version, created_at, updated_at)
       VALUES (?, ?, (SELECT feature_request_id FROM feature_runs WHERE id = ?), 'feature', 60, 'USD', datetime('now'), 1, datetime('now'), datetime('now'))`,
      [`cost-${projectId}-1`, projectId, fr1Before.id],
    );
    const fr1FeatureRequestId = (
      await db.query<{ feature_request_id: string }>(
        `SELECT feature_request_id FROM feature_runs WHERE id = ?`,
        [fr1Before.id],
      )
    )[0]?.feature_request_id;
    if (!fr1FeatureRequestId) throw new Error('FR-001 feature_request_id not found');

    const softEvaluation = await evaluateBudget(db, {
      projectId,
      scope: 'feature',
      featureRequestId: fr1FeatureRequestId,
    });
    if (!softEvaluation) throw new Error('Expected an active budget policy for FR-001');
    assertEqual('soft evaluation status', softEvaluation.status, 'soft_breach');

    let ws = await getWorkflowState(ctx);
    await applyBudgetDecision(db, softEvaluation, {
      projectId,
      expectedVersion: ws.version,
      actor: systemActor(correlationId),
      correlationId,
    });
    ws = await getWorkflowState(ctx);
    assertEqual(
      'automation state after soft breach',
      ws.automation_state,
      'waiting_for_budget_approval',
    );

    // 4. Approver clears the soft breach (waiting_for_budget_approval -> running).
    const overrideWaitingPayload = {
      projectId,
      expectedVersion: ws.version,
      overrideReason: 'soft limit acceptable for this sprint',
      approvedBudgetPolicyId: softEvaluation.policy.id,
    };
    const overrideWaitingEnvelope: CommandEnvelope<typeof overrideWaitingPayload> = {
      commandId: generateId(),
      idempotencyKey: `budget-override-waiting:${projectId}:${ws.version}`,
      payload: overrideWaitingPayload,
      actor: approverActor(correlationId),
      correlationId,
    };
    const executor = new TransactionalCommandExecutor(db);
    await executor.execute(approveOverrideHandler, overrideWaitingEnvelope);
    ws = await getWorkflowState(ctx);
    assertEqual('automation state after soft override', ws.automation_state, 'running');

    // 4b. HIGH-1 regression: spend keeps accumulating after the override and crosses the soft
    // limit a second time. If applyBudgetDecision's idempotency key were scoped to projectId
    // alone, this call would incorrectly replay the first soft breach's cached command result
    // instead of executing — leaving automation_state at 'running' instead of transitioning back
    // to 'waiting_for_budget_approval'.
    await db.execute(
      `INSERT INTO cost_records (id, project_id, feature_request_id, scope, amount, currency, recorded_at, version, created_at, updated_at)
       VALUES (?, ?, ?, 'feature', 5, 'USD', datetime('now'), 1, datetime('now'), datetime('now'))`,
      [`cost-${projectId}-1b`, projectId, fr1FeatureRequestId],
    );
    const secondSoftEvaluation = await evaluateBudget(db, {
      projectId,
      scope: 'feature',
      featureRequestId: fr1FeatureRequestId,
    });
    if (!secondSoftEvaluation) throw new Error('Expected an active budget policy for FR-001');
    assertEqual('second soft evaluation status', secondSoftEvaluation.status, 'soft_breach');

    await applyBudgetDecision(db, secondSoftEvaluation, {
      projectId,
      expectedVersion: ws.version,
      actor: systemActor(correlationId),
      correlationId,
    });
    ws = await getWorkflowState(ctx);
    assertEqual(
      'automation state after repeated soft breach',
      ws.automation_state,
      'waiting_for_budget_approval',
    );

    // Clear the second soft breach too, using a distinct idempotency key (version-scoped) from
    // the first override at step 4 — otherwise this call would replay step 4's cached result.
    const secondOverrideWaitingPayload = {
      projectId,
      expectedVersion: ws.version,
      overrideReason: 'soft limit acceptable again',
      approvedBudgetPolicyId: secondSoftEvaluation.policy.id,
    };
    const secondOverrideWaitingEnvelope: CommandEnvelope<typeof secondOverrideWaitingPayload> = {
      commandId: generateId(),
      idempotencyKey: `budget-override-waiting:${projectId}:${ws.version}`,
      payload: secondOverrideWaitingPayload,
      actor: approverActor(correlationId),
      correlationId,
    };
    await executor.execute(approveOverrideHandler, secondOverrideWaitingEnvelope);
    ws = await getWorkflowState(ctx);
    assertEqual('automation state after second soft override', ws.automation_state, 'running');

    // 5. Hard budget breach (cumulative spend now exceeds hard_limit=100).
    await db.execute(
      `INSERT INTO cost_records (id, project_id, feature_request_id, scope, amount, currency, recorded_at, version, created_at, updated_at)
       VALUES (?, ?, ?, 'feature', 90, 'USD', datetime('now'), 1, datetime('now'), datetime('now'))`,
      [`cost-${projectId}-2`, projectId, fr1FeatureRequestId],
    );
    const hardEvaluation = await evaluateBudget(db, {
      projectId,
      scope: 'feature',
      featureRequestId: fr1FeatureRequestId,
    });
    if (!hardEvaluation) throw new Error('Expected an active budget policy for FR-001');
    assertEqual('hard evaluation status', hardEvaluation.status, 'hard_breach');

    await applyBudgetDecision(db, hardEvaluation, {
      projectId,
      expectedVersion: ws.version,
      actor: systemActor(correlationId),
      correlationId,
    });
    ws = await getWorkflowState(ctx);
    assertEqual(
      'automation state after hard breach',
      ws.automation_state,
      'paused_budget_exceeded',
    );

    // 6. Approver clears the hard breach (paused_budget_exceeded -> running) and a policy_decision
    // is recorded for the override.
    const overrideExceededPayload = {
      projectId,
      expectedVersion: ws.version,
      overrideReason: 'hard limit override for scenario continuation',
      approvedBudgetPolicyId: hardEvaluation.policy.id,
    };
    const overrideExceededEnvelope: CommandEnvelope<typeof overrideExceededPayload> = {
      commandId: generateId(),
      idempotencyKey: `budget-override:${projectId}:${ws.version}`,
      payload: overrideExceededPayload,
      actor: approverActor(correlationId),
      correlationId,
    };
    await executor.execute(approveOverrideHandler, overrideExceededEnvelope);
    ws = await getWorkflowState(ctx);
    assertEqual('automation state after hard override', ws.automation_state, 'running');

    // Three overrides total: two soft-limit clears (step 4 and step 4b) and one hard-limit clear.
    const policyDecisions = await db.query<{ id: string }>(
      `SELECT id FROM policy_decisions WHERE project_id = ? AND policy_type = 'budget_override'`,
      [projectId],
    );
    if (policyDecisions.length !== 3) {
      throw new Error(
        `Expected 3 budget_override policy_decisions rows, got ${policyDecisions.length}`,
      );
    }

    // 7. Simulate FR-001 completing (merged) so FR-002's dependency is satisfied, then clear the
    // active-feature-run pointer so SelectFeatureCommand can select FR-002 next — mirroring what
    // the (Phase 12+) merge gate will eventually do for real.
    await db.execute(`UPDATE feature_runs SET current_execution_state = 'merged' WHERE id = ?`, [
      fr1Before.id,
    ]);
    await db.execute(
      `UPDATE workflow_states SET active_feature_run_id = NULL, version = version + 1 WHERE project_id = ?`,
      [projectId],
    );

    const fr2Before = await getFeatureRunByFrId(ctx, 'FR-002');
    const thirdRun = await runner.run(
      'start-next-feature',
      { projectId, correlationId, idempotencyKey: `idem-snf-3-${projectId}` },
      runStartNextFeature,
    );
    assertEqual('third start-next-feature started', thirdRun.result.started, true);
    assertEqual(
      'third start-next-feature selects FR-002',
      thirdRun.result.featureRunId,
      fr2Before.id,
    );

    const fr2After = await db.query<FeatureRunRow>(
      `SELECT id, current_execution_state FROM feature_runs WHERE id = ?`,
      [fr2Before.id],
    );
    assertEqual('FR-002 reaches coding', fr2After[0]?.current_execution_state, 'coding');
  },
};
