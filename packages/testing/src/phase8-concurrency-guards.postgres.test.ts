import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  FeatureExecutionState,
  AutomationState,
  SelectFeatureHandler,
  StartCodingHandler,
  PauseAutomationHandler,
  RecordBudgetExceededHandler,
  TransactionalCommandExecutor,
  CommandError,
  generateId,
} from '@minicoder/core';
import type { ActorIdentity, CommandEnvelope } from '@minicoder/core';
import { WorkflowLockManager, LockConflictError } from '@minicoder/workflow';
import { PostgresDbClient } from '@minicoder/persistence-postgres';

/**
 * Issue #41: MINICODER_TEST_PG_URL-gated PostgreSQL integration tests for the Phase 8
 * concurrency guards documented in CLAUDE.md's Execution Orchestrator Operational Constraints —
 * exercised against a real PostgreSQL instance (not SQLite), since these are genuine multi-writer
 * races and (per the finding documented in `execution-orchestrator-concurrency.postgres.test.ts`
 * / docs/04 §12.15) SQLite's single-threaded synchronous connection cannot host a real one.
 * Follows the `runner.postgres.test.ts`/`registry.postgres.test.ts` schema-per-suite pattern.
 *
 * Covers:
 * 1. `SelectFeatureHandler`'s `workflow_states.active_feature_run_id` compare-and-swap — only one
 *    of two concurrently-dispatched `SelectFeatureCommand`s for the same project may succeed.
 * 2. `StartCodingHandler`'s atomic `automation_state = 'running'` re-check racing a concurrent
 *    `PauseAutomationCommand` — the two must never both "win" (coding starts under a pause).
 * 3. The `idempotency_keys` claim-first `INSERT ... ON CONFLICT DO NOTHING` — two concurrent
 *    dispatches of the identical command+idempotency-key must produce exactly one real state
 *    transition, with the second returning the first's cached result rather than a duplicate one.
 * 4. `WorkflowLockManager`'s fence-token compare-and-swap — only one of two concurrent
 *    `acquire()` calls for the same lock resource may succeed, and the fence strictly increases
 *    across a release/re-acquire cycle.
 */

const TEST_PG_URL = process.env['MINICODER_TEST_PG_URL'];
const RUN_PG = !!TEST_PG_URL;

const TEST_SCHEMA = 'minicoder_test_phase8_concurrency_guards';
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations/migrations');

function listPgMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.postgres.sql') && !f.includes('.down.'))
    .sort();
}

async function applyAllMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (const file of listPgMigrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [
        file.replace(/\.postgres\.sql$/, ''),
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

function operatorActor(correlationId: string): ActorIdentity {
  return { id: 'test-operator', role: 'operator', actorKind: 'human', correlationId };
}
function systemActor(correlationId: string): ActorIdentity {
  return { id: 'test-system', role: 'admin', actorKind: 'system', correlationId };
}

const selectFeatureHandler = new SelectFeatureHandler();
const startCodingHandler = new StartCodingHandler();
const pauseHandler = new PauseAutomationHandler();
const recordBudgetExceededHandler = new RecordBudgetExceededHandler();

describe.skipIf(!RUN_PG)('issue #41: Phase 8 concurrency guards (PostgreSQL)', () => {
  let pool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: TEST_PG_URL! });
    await adminPool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await adminPool.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await adminPool.end();

    const url = new URL(TEST_PG_URL!);
    url.searchParams.set('options', `-c search_path="${TEST_SCHEMA}"`);
    pool = new Pool({ connectionString: url.toString() });

    await applyAllMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
    const adminPool = new Pool({ connectionString: TEST_PG_URL! });
    await adminPool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await adminPool.end();
  });

  async function seedProjectWithTwoFeatureRuns(suffix: string): Promise<{
    projectId: string;
    featureRunIds: [string, string];
    correlationId: string;
  }> {
    const projectId = `proj-${suffix}`;
    const planId = `plan-${projectId}`;
    const frIds: [string, string] = [`fr-${projectId}-1`, `fr-${projectId}-2`];
    const featureRunIds: [string, string] = [`run-${projectId}-1`, `run-${projectId}-2`];
    const correlationId = `corr-${projectId}`;

    const client = await pool.connect();
    try {
      const db = new PostgresDbClient(client);
      await db.execute(
        `INSERT INTO projects (id, name, description, state, version, created_at, updated_at)
         VALUES (?, 'Phase 8 Guard Project', 'Fixture', 'active', 1, NOW(), NOW())`,
        [projectId],
      );
      await db.execute(
        `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
         VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, NOW(), NOW())`,
        [planId, projectId],
      );
      for (let i = 0; i < 2; i++) {
        await db.execute(
          `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'Feature', 'Description', 'feature', TRUE, ?, ?, 1, NOW(), NOW())`,
          [
            frIds[i],
            planId,
            projectId,
            `FR-00${i + 1}`,
            FeatureExecutionState.APPROVED_PENDING_EXECUTION,
            i,
          ],
        );
        await db.execute(
          `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
           VALUES (?, ?, 1, ?, 1, NOW(), NOW())`,
          [featureRunIds[i], frIds[i], FeatureExecutionState.APPROVED_PENDING_EXECUTION],
        );
      }
      await db.execute(
        `INSERT INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
         VALUES (?, ?, NULL, 'running', 1, NOW(), NOW())`,
        [`ws-${projectId}`, projectId],
      );
      return { projectId, featureRunIds, correlationId };
    } finally {
      client.release();
    }
  }

  it('1. SelectFeatureHandler CAS: exactly one of two concurrent selections wins', async () => {
    const { projectId, featureRunIds, correlationId } =
      await seedProjectWithTwoFeatureRuns('select-cas');

    const [clientA, clientB] = await Promise.all([pool.connect(), pool.connect()]);
    try {
      const executorA = new TransactionalCommandExecutor(new PostgresDbClient(clientA));
      const executorB = new TransactionalCommandExecutor(new PostgresDbClient(clientB));

      const makeEnvelope = (
        featureRunId: string,
      ): CommandEnvelope<{
        featureRunId: string;
        projectId: string;
        expectedVersion: number;
      }> => ({
        commandId: generateId(),
        idempotencyKey: `select-feature:${featureRunId}`,
        payload: { featureRunId, projectId, expectedVersion: 1 },
        actor: operatorActor(correlationId),
        correlationId,
      });

      const results = await Promise.allSettled([
        executorA.execute(selectFeatureHandler, makeEnvelope(featureRunIds[0])),
        executorB.execute(selectFeatureHandler, makeEnvelope(featureRunIds[1])),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CommandError);
      expect(((rejected[0] as PromiseRejectedResult).reason as CommandError).problem.type).toBe(
        'feature-already-active',
      );

      const verifyClient = await pool.connect();
      try {
        const db = new PostgresDbClient(verifyClient);
        const ws = await db.query<{ active_feature_run_id: string | null }>(
          `SELECT active_feature_run_id FROM workflow_states WHERE project_id = ?`,
          [projectId],
        );
        expect(featureRunIds).toContain(ws[0]?.active_feature_run_id);

        const runs = await db.query<{ id: string; current_execution_state: string }>(
          `SELECT id, current_execution_state FROM feature_runs WHERE id = ANY(?)`,
          [featureRunIds],
        );
        const selected = runs.filter(
          (r) => r.current_execution_state === FeatureExecutionState.SELECTED,
        );
        expect(selected.length).toBe(1);
        expect(selected[0]?.id).toBe(ws[0]?.active_feature_run_id);
      } finally {
        verifyClient.release();
      }
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  it('2. StartCodingHandler atomic automation-state re-check never lets coding start under a pause', async () => {
    const { projectId, featureRunIds, correlationId } =
      await seedProjectWithTwoFeatureRuns('start-coding-pause-race');
    const featureRunId = featureRunIds[0];

    // Select the feature first (sequential setup, not part of the race under test).
    const setupClient = await pool.connect();
    let lockManagerDb: PostgresDbClient;
    try {
      const db = new PostgresDbClient(setupClient);
      lockManagerDb = db;
      const executor = new TransactionalCommandExecutor(db);
      await executor.execute(selectFeatureHandler, {
        commandId: generateId(),
        idempotencyKey: `select-feature:${featureRunId}`,
        payload: { featureRunId, projectId, expectedVersion: 1 },
        actor: operatorActor(correlationId),
        correlationId,
      });
    } finally {
      setupClient.release();
    }

    const wsClient = await pool.connect();
    let wsVersion: number;
    let featureRunVersion: number;
    try {
      const db = new PostgresDbClient(wsClient);
      const ws = await db.query<{ version: number }>(
        `SELECT version FROM workflow_states WHERE project_id = ?`,
        [projectId],
      );
      wsVersion = ws[0]!.version;
      const fr = await db.query<{ version: number }>(
        `SELECT version FROM feature_runs WHERE id = ?`,
        [featureRunId],
      );
      featureRunVersion = fr[0]!.version;
    } finally {
      wsClient.release();
    }

    const [pauseClient, codingClient, lockClient] = await Promise.all([
      pool.connect(),
      pool.connect(),
      pool.connect(),
    ]);
    try {
      const lockManager = new WorkflowLockManager(new PostgresDbClient(lockClient));
      const lock = await lockManager.acquire(projectId, `execution-lane:${projectId}`, {
        holderId: 'test-holder',
        ttlMs: 30_000,
      });

      const pauseExecutor = new TransactionalCommandExecutor(new PostgresDbClient(pauseClient));
      const codingExecutor = new TransactionalCommandExecutor(new PostgresDbClient(codingClient));

      const pauseEnvelope: CommandEnvelope<{ projectId: string; expectedVersion: number }> = {
        commandId: generateId(),
        idempotencyKey: `pause-automation:${projectId}:${wsVersion}`,
        payload: { projectId, expectedVersion: wsVersion },
        actor: operatorActor(correlationId),
        correlationId,
      };
      const codingEnvelope: CommandEnvelope<{
        featureRunId: string;
        projectId: string;
        expectedVersion: number;
      }> = {
        commandId: generateId(),
        idempotencyKey: `start-coding:${featureRunId}`,
        payload: { featureRunId, projectId, expectedVersion: featureRunVersion },
        actor: systemActor(correlationId),
        correlationId,
        lockContext: {
          lockId: lock.lockId,
          fence: lock.fence,
          holderId: lock.holderId,
          projectId,
          resourceKey: lock.resourceKey,
        },
      };

      const results = await Promise.allSettled([
        pauseExecutor.execute(pauseHandler, pauseEnvelope),
        codingExecutor.execute(startCodingHandler, codingEnvelope),
      ]);

      // Invariant: coding succeeding and pause succeeding are not both possible with coding
      // having actually started — if StartCodingCommand succeeded, automation must be running;
      // if automation ended up paused, StartCodingCommand must have failed with automation-paused.
      const verifyClient = await pool.connect();
      try {
        const db = new PostgresDbClient(verifyClient);
        const runRows = await db.query<{ current_execution_state: string }>(
          `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
          [featureRunId],
        );
        const wsRows = await db.query<{ automation_state: string }>(
          `SELECT automation_state FROM workflow_states WHERE project_id = ?`,
          [projectId],
        );
        const finalRunState = runRows[0]!.current_execution_state;
        const finalAutomationState = wsRows[0]!.automation_state;

        const codingResult = results[1];
        if (codingResult.status === 'fulfilled') {
          expect(finalRunState).toBe(FeatureExecutionState.CODING);
          expect(finalAutomationState).toBe(AutomationState.RUNNING);
        } else {
          expect(codingResult.reason).toBeInstanceOf(CommandError);
          expect((codingResult.reason as CommandError).problem.type).toBe('automation-paused');
          expect(finalRunState).toBe(FeatureExecutionState.SELECTED);
        }
      } finally {
        verifyClient.release();
      }

      await lockManager.release(lock);
      void lockManagerDb;
    } finally {
      pauseClient.release();
      codingClient.release();
      lockClient.release();
    }
  });

  it('3. idempotency_keys claim-first ON CONFLICT: two concurrent identical dispatches produce exactly one transition', async () => {
    const { projectId, correlationId } = await seedProjectWithTwoFeatureRuns('idempotency-cas');

    const budgetClient = await pool.connect();
    try {
      const db = new PostgresDbClient(budgetClient);
      await db.execute(
        `INSERT INTO budget_policies (id, project_id, scope, feature_request_id, currency, soft_limit, hard_limit, window_days, is_active, version, created_at, updated_at)
         VALUES (?, ?, 'project', NULL, 'USD', 50, 100, NULL, TRUE, 1, NOW(), NOW())`,
        [`budget-${projectId}`, projectId],
      );
    } finally {
      budgetClient.release();
    }

    const [clientA, clientB] = await Promise.all([pool.connect(), pool.connect()]);
    try {
      const executorA = new TransactionalCommandExecutor(new PostgresDbClient(clientA));
      const executorB = new TransactionalCommandExecutor(new PostgresDbClient(clientB));

      const sharedIdempotencyKey = `budget-exceeded:${projectId}:budget-${projectId}:1`;
      const makeEnvelope = (): CommandEnvelope<{
        projectId: string;
        expectedVersion: number;
        breachedPolicyId: string;
        currentSpend: number;
        hardLimit: number;
      }> => ({
        commandId: generateId(),
        idempotencyKey: sharedIdempotencyKey,
        payload: {
          projectId,
          expectedVersion: 1,
          breachedPolicyId: `budget-${projectId}`,
          currentSpend: 150,
          hardLimit: 100,
        },
        actor: systemActor(correlationId),
        correlationId,
      });

      const results = await Promise.allSettled([
        executorA.execute(recordBudgetExceededHandler, makeEnvelope()),
        executorB.execute(recordBudgetExceededHandler, makeEnvelope()),
      ]);

      // Both must resolve without error (the loser replays the winner's committed result rather
      // than erroring) — this is the ON CONFLICT DO NOTHING claim-first contract under real
      // concurrent PostgreSQL transactions, not merely sequential re-dispatch.
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
      }
      const [resultA, resultB] = results as [
        PromiseFulfilledResult<unknown>,
        PromiseFulfilledResult<unknown>,
      ];
      expect(resultA.value).toEqual(resultB.value);

      const verifyClient = await pool.connect();
      try {
        const db = new PostgresDbClient(verifyClient);
        const events = await db.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM workflow_events WHERE project_id = ? AND event_type = 'automation.budget_exceeded'`,
          [projectId],
        );
        // Exactly one real transition — reverting the ON CONFLICT DO NOTHING claim to a bare
        // INSERT (or removing the claim-first check entirely) would double this count.
        expect(Number(events[0]!.count)).toBe(1);

        const ws = await db.query<{ automation_state: string }>(
          `SELECT automation_state FROM workflow_states WHERE project_id = ?`,
          [projectId],
        );
        expect(ws[0]!.automation_state).toBe(AutomationState.PAUSED_BUDGET_EXCEEDED);
      } finally {
        verifyClient.release();
      }
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  it('4. WorkflowLockManager fence-token CAS: one winner per concurrent acquire, fence strictly increases across a release/re-acquire cycle', async () => {
    const projectId = 'proj-lock-fence-cas';
    const resourceKey = `execution-lane:${projectId}`;

    const [clientA, clientB] = await Promise.all([pool.connect(), pool.connect()]);
    try {
      const lockManagerA = new WorkflowLockManager(new PostgresDbClient(clientA));
      const lockManagerB = new WorkflowLockManager(new PostgresDbClient(clientB));

      const results = await Promise.allSettled([
        lockManagerA.acquire(projectId, resourceKey, { holderId: 'holder-a', ttlMs: 30_000 }),
        lockManagerB.acquire(projectId, resourceKey, { holderId: 'holder-b', ttlMs: 30_000 }),
      ]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof lockManagerA.acquire>>> =>
          r.status === 'fulfilled',
      );
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LockConflictError);

      const winningLock = fulfilled[0]!.value;
      expect(winningLock.fence).toBe(1);

      // Release and re-acquire: fence must strictly increase, never reset.
      await lockManagerA.release(winningLock);
      const reacquired = await lockManagerA.acquire(projectId, resourceKey, {
        holderId: 'holder-a',
        ttlMs: 30_000,
      });
      expect(reacquired.fence).toBeGreaterThan(winningLock.fence);
      await lockManagerA.release(reacquired);
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});
