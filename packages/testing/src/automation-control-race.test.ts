import { describe, it, expect, beforeEach } from 'vitest';
import {
  ApproveBudgetOverrideHandler,
  FeatureExecutionState,
  AutomationState,
  PauseAutomationHandler,
  RecordBudgetExceededHandler,
  ResumeAutomationHandler,
  SelectFeatureHandler,
  StartCodingHandler,
  StartFixingHandler,
  TransactionalCommandExecutor,
  generateId,
} from '@minicoder/core';
import type { ActorIdentity, CommandEnvelope, DbClient } from '@minicoder/core';
import { ExecutionLane } from '@minicoder/workflow';
import { createTestDb } from './db.js';

/**
 * Regression coverage for the Phase 8 code-review findings on the automation-control /
 * budget-gate race (HIGH-1) and repeatable-transition idempotency keys (MEDIUM-1). These
 * commands have no Trigger.dev task or scenario home yet (pause/resume/start-fixing are all
 * still caller-less in Phase 8 — see CLAUDE.md's Execution Orchestrator Operational
 * Constraints), so they are dispatched directly here via TransactionalCommandExecutor, the same
 * way a future Phase 13 API handler or Phase 10 review/fix loop caller eventually will.
 */

const projectId = 'proj-automation-control-race';
const planId = `plan-${projectId}`;
const frId = `fr-${projectId}-1`;
const featureRunId = `run-${projectId}-1`;
const correlationId = `corr-${projectId}`;

const selectFeatureHandler = new SelectFeatureHandler();
const startCodingHandler = new StartCodingHandler();
const startFixingHandler = new StartFixingHandler();
const pauseHandler = new PauseAutomationHandler();
const resumeHandler = new ResumeAutomationHandler();
const recordBudgetExceededHandler = new RecordBudgetExceededHandler();
const approveOverrideHandler = new ApproveBudgetOverrideHandler();

function operatorActor(): ActorIdentity {
  return { id: 'test-operator', role: 'operator', actorKind: 'human', correlationId };
}
function systemActor(): ActorIdentity {
  return { id: 'test-system', role: 'admin', actorKind: 'system', correlationId };
}
function approverActor(): ActorIdentity {
  return { id: 'test-approver', role: 'approver', actorKind: 'human', correlationId };
}

async function seed(db: DbClient): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, description, state, version, created_at, updated_at)
     VALUES (?, 'Automation Control Race Project', 'Fixture', 'active', 1, datetime('now'), datetime('now'))`,
    [projectId],
  );
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
    [planId, projectId],
  );
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, ?, 0, 1, datetime('now'), datetime('now'))`,
    [frId, planId, projectId, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
  );
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
     VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
    [featureRunId, frId, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
  );
  await db.execute(
    `INSERT INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'running', 1, datetime('now'), datetime('now'))`,
    [`ws-${projectId}`, projectId],
  );
  await db.execute(
    `INSERT INTO budget_policies (id, project_id, scope, feature_request_id, currency, soft_limit, hard_limit, window_days, is_active, version, created_at, updated_at)
     VALUES (?, ?, 'project', NULL, 'USD', 50, 100, NULL, 1, 1, datetime('now'), datetime('now'))`,
    [`budget-${projectId}`, projectId],
  );
}

interface WorkflowStateRow {
  automation_state: string;
  version: number;
}
interface FeatureRunRow {
  current_execution_state: string;
  version: number;
}

async function getWorkflowState(db: DbClient): Promise<WorkflowStateRow> {
  const rows = await db.query<WorkflowStateRow>(
    `SELECT automation_state, version FROM workflow_states WHERE project_id = ?`,
    [projectId],
  );
  const row = rows[0];
  if (!row) throw new Error('No workflow_states row found');
  return row;
}

async function getFeatureRun(db: DbClient): Promise<FeatureRunRow> {
  const rows = await db.query<FeatureRunRow>(
    `SELECT current_execution_state, version FROM feature_runs WHERE id = ?`,
    [featureRunId],
  );
  const row = rows[0];
  if (!row) throw new Error('No feature_runs row found');
  return row;
}

async function countWorkflowEvents(db: DbClient, eventType: string): Promise<number> {
  const rows = await db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM workflow_events WHERE project_id = ? AND event_type = ?`,
    [projectId, eventType],
  );
  return Number(rows[0]?.count ?? 0);
}

describe('HIGH-1: automation control cannot be bypassed between selection and coding start', () => {
  let db: DbClient;
  let executor: TransactionalCommandExecutor;

  beforeEach(async () => {
    db = createTestDb();
    await seed(db);
    executor = new TransactionalCommandExecutor(db);
  });

  it('rejects StartCodingCommand when automation was paused after selection', async () => {
    const selectEnvelope: CommandEnvelope<{
      featureRunId: string;
      projectId: string;
      expectedVersion: number;
    }> = {
      commandId: generateId(),
      idempotencyKey: `select-feature:${featureRunId}`,
      payload: { featureRunId, projectId, expectedVersion: 1 },
      actor: operatorActor(),
      correlationId,
    };
    await executor.execute(selectFeatureHandler, selectEnvelope);

    const ws = await getWorkflowState(db);
    const pauseEnvelope: CommandEnvelope<{ projectId: string; expectedVersion: number }> = {
      commandId: generateId(),
      idempotencyKey: `pause-automation:${projectId}:${ws.version}`,
      payload: { projectId, expectedVersion: ws.version },
      actor: operatorActor(),
      correlationId,
    };
    await executor.execute(pauseHandler, pauseEnvelope);
    expect((await getWorkflowState(db)).automation_state).toBe(AutomationState.PAUSED_BY_OPERATOR);

    const featureRun = await getFeatureRun(db);
    // Use a real ExecutionLane lock so assertLockFence passes and the automation-state guard
    // (not the lock guard) is what's actually exercised.
    const lane = new ExecutionLane(db);
    const lock = await lane.acquireForProject(projectId, 'test-holder', 30_000);
    const startCodingEnvelope: CommandEnvelope<{
      featureRunId: string;
      projectId: string;
      expectedVersion: number;
    }> = {
      commandId: generateId(),
      idempotencyKey: `start-coding:${featureRunId}`,
      payload: { featureRunId, projectId, expectedVersion: featureRun.version },
      actor: systemActor(),
      correlationId,
      lockContext: {
        lockId: lock.lockId,
        fence: lock.fence,
        holderId: lock.holderId,
        projectId,
        resourceKey: lock.resourceKey,
      },
    };

    await expect(executor.execute(startCodingHandler, startCodingEnvelope)).rejects.toMatchObject({
      problem: { type: 'automation-paused' },
    });

    const runAfter = await getFeatureRun(db);
    expect(runAfter.current_execution_state).toBe(FeatureExecutionState.SELECTED);
  });

  it('rejects StartCodingCommand when a hard budget breach paused automation after selection', async () => {
    const selectEnvelope: CommandEnvelope<{
      featureRunId: string;
      projectId: string;
      expectedVersion: number;
    }> = {
      commandId: generateId(),
      idempotencyKey: `select-feature:${featureRunId}`,
      payload: { featureRunId, projectId, expectedVersion: 1 },
      actor: operatorActor(),
      correlationId,
    };
    await executor.execute(selectFeatureHandler, selectEnvelope);

    const ws = await getWorkflowState(db);
    const breachEnvelope: CommandEnvelope<{
      projectId: string;
      expectedVersion: number;
      breachedPolicyId: string;
      currentSpend: number;
      hardLimit: number;
    }> = {
      commandId: generateId(),
      idempotencyKey: `budget-exceeded:${projectId}:budget-${projectId}:${ws.version}`,
      payload: {
        projectId,
        expectedVersion: ws.version,
        breachedPolicyId: `budget-${projectId}`,
        currentSpend: 150,
        hardLimit: 100,
      },
      actor: systemActor(),
      correlationId,
    };
    await executor.execute(recordBudgetExceededHandler, breachEnvelope);
    expect((await getWorkflowState(db)).automation_state).toBe(
      AutomationState.PAUSED_BUDGET_EXCEEDED,
    );

    const featureRun = await getFeatureRun(db);
    const lane = new ExecutionLane(db);
    const lock = await lane.acquireForProject(projectId, 'test-holder', 30_000);
    const startCodingEnvelope: CommandEnvelope<{
      featureRunId: string;
      projectId: string;
      expectedVersion: number;
    }> = {
      commandId: generateId(),
      idempotencyKey: `start-coding:${featureRunId}`,
      payload: { featureRunId, projectId, expectedVersion: featureRun.version },
      actor: systemActor(),
      correlationId,
      lockContext: {
        lockId: lock.lockId,
        fence: lock.fence,
        holderId: lock.holderId,
        projectId,
        resourceKey: lock.resourceKey,
      },
    };

    await expect(executor.execute(startCodingHandler, startCodingEnvelope)).rejects.toMatchObject({
      problem: { type: 'automation-paused' },
    });

    const runAfter = await getFeatureRun(db);
    expect(runAfter.current_execution_state).toBe(FeatureExecutionState.SELECTED);
  });
});

describe('MEDIUM-1: repeatable automation-control transitions use occurrence-scoped idempotency keys', () => {
  let db: DbClient;
  let executor: TransactionalCommandExecutor;

  beforeEach(async () => {
    db = createTestDb();
    await seed(db);
    executor = new TransactionalCommandExecutor(db);
  });

  async function pause(): Promise<void> {
    const ws = await getWorkflowState(db);
    const envelope: CommandEnvelope<{ projectId: string; expectedVersion: number }> = {
      commandId: generateId(),
      idempotencyKey: `pause-automation:${projectId}:${ws.version}`,
      payload: { projectId, expectedVersion: ws.version },
      actor: operatorActor(),
      correlationId,
    };
    await executor.execute(pauseHandler, envelope);
  }

  async function resume(): Promise<void> {
    const ws = await getWorkflowState(db);
    const envelope: CommandEnvelope<{ projectId: string; expectedVersion: number }> = {
      commandId: generateId(),
      idempotencyKey: `resume-automation:${projectId}:${ws.version}`,
      payload: { projectId, expectedVersion: ws.version },
      actor: operatorActor(),
      correlationId,
    };
    await executor.execute(resumeHandler, envelope);
  }

  it('a second pause within the idempotency TTL actually transitions, not a cache replay', async () => {
    await pause();
    await resume();
    await pause();

    expect((await getWorkflowState(db)).automation_state).toBe(AutomationState.PAUSED_BY_OPERATOR);
    expect(await countWorkflowEvents(db, 'automation.paused_by_operator')).toBe(2);
  });

  it('a second resume within the idempotency TTL actually transitions, not a cache replay', async () => {
    await pause();
    await resume();
    await pause();
    await resume();

    expect((await getWorkflowState(db)).automation_state).toBe(AutomationState.RUNNING);
    expect(await countWorkflowEvents(db, 'automation.resumed')).toBe(2);
  });

  it('two changes_requested -> fixing cycles for the same feature run both transition', async () => {
    const lane = new ExecutionLane(db);

    async function driveFixingCycle(): Promise<void> {
      await db.execute(`UPDATE feature_runs SET current_execution_state = ? WHERE id = ?`, [
        FeatureExecutionState.CHANGES_REQUESTED,
        featureRunId,
      ]);
      const run = await getFeatureRun(db);
      const lock = await lane.acquireForProject(projectId, 'test-holder', 30_000);
      try {
        const envelope: CommandEnvelope<{
          featureRunId: string;
          projectId: string;
          expectedVersion: number;
        }> = {
          commandId: generateId(),
          idempotencyKey: `start-fixing:${featureRunId}:${run.version}`,
          payload: { featureRunId, projectId, expectedVersion: run.version },
          actor: systemActor(),
          correlationId,
          lockContext: {
            lockId: lock.lockId,
            fence: lock.fence,
            holderId: lock.holderId,
            projectId,
            resourceKey: lock.resourceKey,
          },
        };
        await executor.execute(startFixingHandler, envelope);
      } finally {
        await lane.releaseForProject(lock);
      }
    }

    await driveFixingCycle();
    expect((await getFeatureRun(db)).current_execution_state).toBe(FeatureExecutionState.FIXING);

    await driveFixingCycle();
    expect((await getFeatureRun(db)).current_execution_state).toBe(FeatureExecutionState.FIXING);

    expect(await countWorkflowEvents(db, 'feature.fixing_started')).toBe(2);
  });

  it('StartFixingCommand is rejected when automation is paused (same guard as StartCodingCommand)', async () => {
    await db.execute(`UPDATE feature_runs SET current_execution_state = ? WHERE id = ?`, [
      FeatureExecutionState.CHANGES_REQUESTED,
      featureRunId,
    ]);
    await pause();

    const run = await getFeatureRun(db);
    const lane = new ExecutionLane(db);
    const lock = await lane.acquireForProject(projectId, 'test-holder', 30_000);
    const envelope: CommandEnvelope<{
      featureRunId: string;
      projectId: string;
      expectedVersion: number;
    }> = {
      commandId: generateId(),
      idempotencyKey: `start-fixing:${featureRunId}:${run.version}`,
      payload: { featureRunId, projectId, expectedVersion: run.version },
      actor: systemActor(),
      correlationId,
      lockContext: {
        lockId: lock.lockId,
        fence: lock.fence,
        holderId: lock.holderId,
        projectId,
        resourceKey: lock.resourceKey,
      },
    };

    await expect(executor.execute(startFixingHandler, envelope)).rejects.toMatchObject({
      problem: { type: 'automation-paused' },
    });
    expect((await getFeatureRun(db)).current_execution_state).toBe(
      FeatureExecutionState.CHANGES_REQUESTED,
    );
  });

  it('a second budget override within the idempotency TTL actually transitions, not a cache replay', async () => {
    let ws = await getWorkflowState(db);
    const breachEnvelope1: CommandEnvelope<{
      projectId: string;
      expectedVersion: number;
      breachedPolicyId: string;
      currentSpend: number;
      hardLimit: number;
    }> = {
      commandId: generateId(),
      idempotencyKey: `budget-exceeded:${projectId}:budget-${projectId}:${ws.version}`,
      payload: {
        projectId,
        expectedVersion: ws.version,
        breachedPolicyId: `budget-${projectId}`,
        currentSpend: 150,
        hardLimit: 100,
      },
      actor: systemActor(),
      correlationId,
    };
    await executor.execute(recordBudgetExceededHandler, breachEnvelope1);

    ws = await getWorkflowState(db);
    const override1: CommandEnvelope<{
      projectId: string;
      expectedVersion: number;
      overrideReason: string;
      approvedBudgetPolicyId: string;
    }> = {
      commandId: generateId(),
      idempotencyKey: `budget-override:${projectId}:${ws.version}`,
      payload: {
        projectId,
        expectedVersion: ws.version,
        overrideReason: 'first override',
        approvedBudgetPolicyId: `budget-${projectId}`,
      },
      actor: approverActor(),
      correlationId,
    };
    await executor.execute(approveOverrideHandler, override1);
    expect((await getWorkflowState(db)).automation_state).toBe(AutomationState.RUNNING);

    ws = await getWorkflowState(db);
    const breachEnvelope2: CommandEnvelope<{
      projectId: string;
      expectedVersion: number;
      breachedPolicyId: string;
      currentSpend: number;
      hardLimit: number;
    }> = {
      commandId: generateId(),
      idempotencyKey: `budget-exceeded:${projectId}:budget-${projectId}:${ws.version}`,
      payload: {
        projectId,
        expectedVersion: ws.version,
        breachedPolicyId: `budget-${projectId}`,
        currentSpend: 250,
        hardLimit: 100,
      },
      actor: systemActor(),
      correlationId,
    };
    await executor.execute(recordBudgetExceededHandler, breachEnvelope2);
    expect((await getWorkflowState(db)).automation_state).toBe(
      AutomationState.PAUSED_BUDGET_EXCEEDED,
    );

    ws = await getWorkflowState(db);
    const override2: CommandEnvelope<{
      projectId: string;
      expectedVersion: number;
      overrideReason: string;
      approvedBudgetPolicyId: string;
    }> = {
      commandId: generateId(),
      idempotencyKey: `budget-override:${projectId}:${ws.version}`,
      payload: {
        projectId,
        expectedVersion: ws.version,
        overrideReason: 'second override',
        approvedBudgetPolicyId: `budget-${projectId}`,
      },
      actor: approverActor(),
      correlationId,
    };
    await executor.execute(approveOverrideHandler, override2);

    expect((await getWorkflowState(db)).automation_state).toBe(AutomationState.RUNNING);
    expect(await countWorkflowEvents(db, 'automation.budget_override_approved')).toBe(2);
  });
});
