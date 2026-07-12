import { describe, it, expect } from 'vitest';
import type { DbClient } from '@minicoder/core';
import { createTestDb } from '../test-helpers.js';
import { budgetPreflightCheck, resolveEstimatedCostUsd } from './budget-preflight.js';

const PROJECT_ID = 'proj-budget-preflight';

async function seedProjectWithWorkflowState(db: DbClient, featureRequestId: string): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
  await db.execute(
    `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
    [`plan-${PROJECT_ID}`, PROJECT_ID],
  );
  await db.execute(
    `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, 'approved_pending_execution', 0, 1, datetime('now'), datetime('now'))`,
    [featureRequestId, `plan-${PROJECT_ID}`, PROJECT_ID],
  );
  // A real feature_runs row — workflow_events.feature_run_id has a foreign key, so the Phase 16
  // budget-preflight feature-run attribution (post-merge PR review fix, MEDIUM-2) needs a real
  // row to reference, not just an opaque string.
  await db.execute(
    `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
     VALUES (?, ?, 1, 'coding', 1, datetime('now'), datetime('now'))`,
    [featureRunId(featureRequestId), featureRequestId],
  );
  await db.execute(
    `INSERT OR IGNORE INTO workflow_states (id, project_id, automation_state, version, created_at, updated_at)
     VALUES (?, ?, 'running', 1, datetime('now'), datetime('now'))`,
    [`ws-${PROJECT_ID}`, PROJECT_ID],
  );
}

function featureRunId(featureRequestId: string): string {
  return `run-${featureRequestId}`;
}

async function seedBudgetPolicy(
  db: DbClient,
  featureRequestId: string,
  opts: { hardLimit: number; softLimit?: number },
): Promise<void> {
  await db.execute(
    `INSERT INTO budget_policies (id, project_id, scope, feature_request_id, currency, soft_limit, hard_limit, window_days, is_active, version, created_at, updated_at)
     VALUES (?, ?, 'feature', ?, 'USD', ?, ?, NULL, 1, 1, datetime('now'), datetime('now'))`,
    [
      `policy-${featureRequestId}`,
      PROJECT_ID,
      featureRequestId,
      opts.softLimit ?? null,
      opts.hardLimit,
    ],
  );
}

describe('resolveEstimatedCostUsd', () => {
  it('returns undefined when the env var is unset', () => {
    delete process.env.TEST_ESTIMATED_COST;
    expect(resolveEstimatedCostUsd('TEST_ESTIMATED_COST')).toBeUndefined();
  });

  it('parses a valid numeric value', () => {
    process.env.TEST_ESTIMATED_COST = '2.5';
    expect(resolveEstimatedCostUsd('TEST_ESTIMATED_COST')).toBe(2.5);
    delete process.env.TEST_ESTIMATED_COST;
  });

  it('ignores blank/negative/non-finite values, returning undefined', () => {
    for (const value of ['', '   ', '-1', 'NaN', 'not-a-number']) {
      process.env.TEST_ESTIMATED_COST = value;
      expect(resolveEstimatedCostUsd('TEST_ESTIMATED_COST')).toBeUndefined();
    }
    delete process.env.TEST_ESTIMATED_COST;
  });
});

describe('budgetPreflightCheck', () => {
  it('proceeds with no DB work when estimatedCostUsd is undefined', async () => {
    const db = createTestDb() as unknown as DbClient;
    const result = await budgetPreflightCheck(db, {
      projectId: 'no-such-project',
      featureRequestId: 'no-such-feature',
      scope: 'feature',
      correlationId: 'corr-1',
      estimatedCostUsd: undefined,
      featureRunId: 'fake-feature-run',
    });
    expect(result).toEqual({ proceed: true });
  });

  it('proceeds when no active budget policy exists for the scope', async () => {
    const db = createTestDb() as unknown as DbClient;
    const featureRequestId = 'fr-no-policy';
    await seedProjectWithWorkflowState(db, featureRequestId);

    const result = await budgetPreflightCheck(db, {
      projectId: PROJECT_ID,
      featureRequestId,
      scope: 'feature',
      correlationId: 'corr-2',
      estimatedCostUsd: 1000,
      featureRunId: 'fake-feature-run',
    });
    expect(result).toEqual({ proceed: true });
  });

  it('proceeds when the projected total stays under the hard limit', async () => {
    const db = createTestDb() as unknown as DbClient;
    const featureRequestId = 'fr-under-limit';
    await seedProjectWithWorkflowState(db, featureRequestId);
    await seedBudgetPolicy(db, featureRequestId, { hardLimit: 100 });

    const result = await budgetPreflightCheck(db, {
      projectId: PROJECT_ID,
      featureRequestId,
      scope: 'feature',
      correlationId: 'corr-3',
      estimatedCostUsd: 5,
      featureRunId: 'fake-feature-run',
    });
    expect(result).toEqual({ proceed: true });
  });

  it('skips and records a hard breach when the projected total would exceed the hard limit', async () => {
    const db = createTestDb() as unknown as DbClient;
    const featureRequestId = 'fr-over-limit';
    await seedProjectWithWorkflowState(db, featureRequestId);
    await seedBudgetPolicy(db, featureRequestId, { hardLimit: 10 });

    const result = await budgetPreflightCheck(db, {
      projectId: PROJECT_ID,
      featureRequestId,
      scope: 'feature',
      correlationId: 'corr-4',
      estimatedCostUsd: 50,
      featureRunId: featureRunId(featureRequestId),
    });
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.outcome).toBe('hard_breach');
      expect(result.projectedSpend).toBe(50);
    }

    const events = await db.query<{ event_type: string; feature_run_id: string | null }>(
      `SELECT event_type, feature_run_id FROM workflow_events WHERE project_id = ? ORDER BY occurred_at ASC`,
      [PROJECT_ID],
    );
    const breachEvent = events.find((e) => e.event_type === 'automation.budget_exceeded');
    expect(breachEvent).toBeDefined();
    // Post-merge PR review fix (MEDIUM-2): the breach event is attributed to the feature run
    // whose pre-flight forecast triggered it, so GET /feature-runs/:id/timeline can explain it.
    expect(breachEvent?.feature_run_id).toBe(featureRunId(featureRequestId));

    const workflowState = await db.query<{ automation_state: string }>(
      `SELECT automation_state FROM workflow_states WHERE project_id = ?`,
      [PROJECT_ID],
    );
    expect(workflowState[0]?.automation_state).toBe('paused_budget_exceeded');
  });

  it('fails closed (blocks) on a hard breach when no workflow_states row exists to record it', async () => {
    const db = createTestDb() as unknown as DbClient;
    const featureRequestId = 'fr-over-limit-no-workflow-state';
    // Seed everything a normal call needs except the workflow_states row.
    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, state, version, created_at, updated_at)
       VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
      [PROJECT_ID],
    );
    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
      [`plan-${PROJECT_ID}`, PROJECT_ID],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, 'approved_pending_execution', 0, 1, datetime('now'), datetime('now'))`,
      [featureRequestId, `plan-${PROJECT_ID}`, PROJECT_ID],
    );
    await seedBudgetPolicy(db, featureRequestId, { hardLimit: 10 });

    const result = await budgetPreflightCheck(db, {
      projectId: PROJECT_ID,
      featureRequestId,
      scope: 'feature',
      correlationId: 'corr-6',
      estimatedCostUsd: 50,
      featureRunId: 'fake-feature-run',
    });
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.outcome).toBe('hard_breach');
      expect(result.projectedSpend).toBe(50);
    }

    const workflowState = await db.query<{ automation_state: string }>(
      `SELECT automation_state FROM workflow_states WHERE project_id = ?`,
      [PROJECT_ID],
    );
    expect(workflowState).toEqual([]);
  });

  it('proceeds (fails open) when a forecasted soft breach is reported, not just ok', async () => {
    const db = createTestDb() as unknown as DbClient;
    const featureRequestId = 'fr-soft-breach';
    await seedProjectWithWorkflowState(db, featureRequestId);
    await seedBudgetPolicy(db, featureRequestId, { hardLimit: 100, softLimit: 20 });

    const result = await budgetPreflightCheck(db, {
      projectId: PROJECT_ID,
      featureRequestId,
      scope: 'feature',
      correlationId: 'corr-5',
      estimatedCostUsd: 30,
      featureRunId: 'fake-feature-run',
    });
    expect(result).toEqual({ proceed: true });
  });
});
