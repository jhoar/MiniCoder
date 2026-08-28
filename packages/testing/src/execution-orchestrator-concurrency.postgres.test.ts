import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  FeatureExecutionState,
  AutomationState,
  PauseAutomationHandler,
  TransactionalCommandExecutor,
  OptimisticLockError,
  StaleFenceError,
  CommandError,
  generateId,
} from '@minicoder/core';
import type { ActorIdentity, CommandEnvelope, DbClient } from '@minicoder/core';
import { LockConflictError } from '@minicoder/workflow';
import { PostgresDbClient } from '@minicoder/persistence-postgres';
import { runStartNextFeature, runGithubReconciliation } from '@minicoder/triggerdev';

/**
 * Issue #43: a genuinely concurrent (Promise.all-driven, not sequential) scenario exercising the
 * three real actors that can touch the same project's execution state at once —
 * `start-next-feature` (auto-discovery/selection + coding start), `github-reconciliation` (the
 * scheduled fallback), and an operator pausing automation — asserting the system invariants the
 * Execution Orchestrator's several rounds of sequential concurrency-bug fixes (CLAUDE.md's
 * Execution Orchestrator Operational Constraints) were meant to hold under real interleaving, not
 * just the single-writer-at-a-time races `automation-control-race.test.ts` already covers.
 *
 * **Why this is PostgreSQL-only, gated by `MINICODER_TEST_PG_URL` (same gate as
 * `runner.postgres.test.ts`/`registry.postgres.test.ts`), rather than a SQLite scenario in
 * `packages/testing/src/*.test.ts`:** better-sqlite3 is a fully synchronous native binding
 * running on Node's single thread. Two `SqliteDbClient` connections to the same file *cannot*
 * genuinely race — whichever one's blocking write call runs first monopolizes the only thread
 * until it returns, so a second connection's overlapping write either never actually overlaps (no
 * real race exercised) or deadlocks against `busy_timeout` (the first connection can't reach
 * COMMIT while the second's synchronous busy-wait is blocking the only thread that could run it).
 * This was confirmed empirically while building this test: a multi-connection same-file SQLite
 * version of this exact scenario reliably deadlocked on "database is locked" every iteration.
 * PostgreSQL's client-server architecture has no such limitation — each `pg.Pool` connection is a
 * genuinely independent backend process, so `Promise.all`-driven concurrent transactions here
 * exercise real overlapping writes the way a production hosted/team deployment actually would.
 * This is a new "concurrency scenario" test tier (docs/04 §12) alongside the existing
 * cross-dialect migration/adapter-registry Postgres-gated suites.
 *
 * `github-reconciliation` is included to satisfy the issue's "all three actors" wording; with no
 * `repositories` row seeded, `runImpl` returns a safe no-op before ever needing a live
 * `ScmClient` (it only constructs one after finding a tracked repo) — exactly the
 * scheduled-fallback behavior a project with no GitHub integration configured yet would see.
 */

const TEST_PG_URL = process.env['MINICODER_TEST_PG_URL'];
const RUN_PG = !!TEST_PG_URL;

const TEST_SCHEMA = 'minicoder_test_orchestrator_concurrency';
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

const pauseHandler = new PauseAutomationHandler();

function operatorActor(correlationId: string): ActorIdentity {
  return { id: 'test-operator', role: 'operator', actorKind: 'human', correlationId };
}

interface Fixture {
  projectId: string;
  frIds: [string, string];
  featureRunIds: [string, string];
  correlationId: string;
}

async function seed(db: DbClient, iteration: number): Promise<Fixture> {
  const projectId = `proj-orchestrator-concurrency-${iteration}`;
  const planId = `plan-${projectId}`;
  const frIds: [string, string] = [`fr-${projectId}-1`, `fr-${projectId}-2`];
  const featureRunIds: [string, string] = [`run-${projectId}-1`, `run-${projectId}-2`];
  const correlationId = `corr-${projectId}`;

  await db.execute(
    `INSERT INTO projects (id, name, description, state, version, created_at, updated_at)
     VALUES (?, 'Orchestrator Concurrency Project', 'Fixture', 'active', 1, NOW(), NOW())`,
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

  return { projectId, frIds, featureRunIds, correlationId };
}

interface WorkflowStateRow {
  active_feature_run_id: string | null;
  automation_state: string;
  version: number;
}
interface FeatureRunRow {
  id: string;
  current_execution_state: string;
}

async function getWorkflowState(db: DbClient, projectId: string): Promise<WorkflowStateRow> {
  const rows = await db.query<WorkflowStateRow>(
    `SELECT active_feature_run_id, automation_state, version FROM workflow_states WHERE project_id = ?`,
    [projectId],
  );
  const row = rows[0];
  if (!row) throw new Error('No workflow_states row found');
  return row;
}

async function getFeatureRuns(db: DbClient, featureRunIds: string[]): Promise<FeatureRunRow[]> {
  return db.query<FeatureRunRow>(
    `SELECT id, current_execution_state FROM feature_runs WHERE id IN (${featureRunIds
      .map(() => '?')
      .join(', ')})`,
    featureRunIds,
  );
}

/** Races expected under real interleaving — the same classes `isTransientRace()` (triggerdev
 * tasks) already treats as non-fatal, plus a raw pause-side OptimisticLockError (this test
 * dispatches PauseAutomationCommand directly rather than through a task wrapper), plus
 * PostgreSQL's own serialization-failure/deadlock error codes from genuine concurrent writers. */
function isExpectedRace(err: unknown): boolean {
  if (err instanceof OptimisticLockError) return true;
  if (err instanceof LockConflictError) return true;
  if (err instanceof StaleFenceError) return true;
  if (err instanceof CommandError) {
    return [
      'automation-paused',
      'feature-already-active',
      'concurrent-command',
      'not-found',
    ].includes(err.problem.type);
  }
  const code = (err as { code?: string } | undefined)?.code;
  // 40001 serialization_failure, 40P01 deadlock_detected
  if (code === '40001' || code === '40P01') return true;
  return false;
}

describe.skipIf(!RUN_PG)('issue #43: interleaved-actor concurrency invariants (PostgreSQL)', () => {
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

  const ITERATIONS = 5;

  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    it(`holds single-active-feature and no-lost-transition invariants (iteration ${iteration})`, async () => {
      const [seedClient, startClientA, startClientB, pauseClient] = await Promise.all([
        pool.connect(),
        pool.connect(),
        pool.connect(),
        pool.connect(),
      ]);
      try {
        const seedConn = new PostgresDbClient(seedClient);
        const startConnA = new PostgresDbClient(startClientA);
        const startConnB = new PostgresDbClient(startClientB);
        const pauseConn = new PostgresDbClient(pauseClient);

        const { projectId, featureRunIds, correlationId } = await seed(seedConn, iteration);
        const wsBefore = await getWorkflowState(seedConn, projectId);

        const pauseEnvelope: CommandEnvelope<{ projectId: string; expectedVersion: number }> = {
          commandId: generateId(),
          idempotencyKey: `pause-automation:${projectId}:${wsBefore.version}`,
          payload: { projectId, expectedVersion: wsBefore.version },
          actor: operatorActor(correlationId),
          correlationId,
        };
        const pauseExecutor = new TransactionalCommandExecutor(pauseConn);

        const results = await Promise.allSettled([
          runStartNextFeature(
            {
              projectId,
              correlationId,
              idempotencyKey: `start-next-feature:${featureRunIds[0]}:a`,
              featureRunId: featureRunIds[0],
            },
            startConnA,
          ),
          runStartNextFeature(
            {
              projectId,
              correlationId,
              idempotencyKey: `start-next-feature:${featureRunIds[1]}:b`,
              featureRunId: featureRunIds[1],
            },
            startConnB,
          ),
          pauseExecutor.execute(pauseHandler, pauseEnvelope),
          runGithubReconciliation(
            { projectId, correlationId, idempotencyKey: `github-reconciliation:${projectId}` },
            seedConn,
          ),
        ]);

        for (const result of results) {
          if (result.status === 'rejected' && !isExpectedRace(result.reason)) {
            throw result.reason;
          }
        }

        const wsAfter = await getWorkflowState(seedConn, projectId);
        const runsAfter = await getFeatureRuns(seedConn, featureRunIds);

        // Single-active-feature invariant: at most one feature run left APPROVED_PENDING_EXECUTION.
        const progressed = runsAfter.filter(
          (r) => r.current_execution_state !== FeatureExecutionState.APPROVED_PENDING_EXECUTION,
        );
        expect(progressed.length).toBeLessThanOrEqual(1);

        // No lost transition: if workflow_states points at an active run, that run must
        // actually have progressed (never an orphaned pointer to an unchanged run).
        if (wsAfter.active_feature_run_id !== null) {
          expect(featureRunIds).toContain(wsAfter.active_feature_run_id);
          const activeRun = runsAfter.find((r) => r.id === wsAfter.active_feature_run_id);
          expect(activeRun).toBeDefined();
          expect(activeRun!.current_execution_state).not.toBe(
            FeatureExecutionState.APPROVED_PENDING_EXECUTION,
          );
        }

        // automation_state must land in a valid, non-corrupted value regardless of interleaving.
        expect([AutomationState.RUNNING, AutomationState.PAUSED_BY_OPERATOR]).toContain(
          wsAfter.automation_state,
        );
      } finally {
        seedClient.release();
        startClientA.release();
        startClientB.release();
        pauseClient.release();
      }
    });
  }
});
