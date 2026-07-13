import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import type { DbClient } from '@minicoder/core';
import { PostgresDbClient } from '@minicoder/persistence-postgres';
import { TaskQueueDispatcher } from './task-worker.js';
import type { TaskDefinition } from './task-registry.js';
import type { TaskId } from './task-ids.js';

/**
 * PR #75 review fixes (HIGH-1, HIGH-2): genuine multi-connection concurrency regression tests for
 * `TaskQueueDispatcher`, gated by `MINICODER_TEST_PG_URL` — the same gate as
 * `runner.postgres.test.ts`/`registry.postgres.test.ts` and the same rationale as
 * `packages/testing/src/execution-orchestrator-concurrency.postgres.test.ts`'s own doc comment:
 * better-sqlite3 is a fully synchronous native binding on Node's single thread, so two
 * `SqliteDbClient` connections to the same file cannot genuinely race — confirmed empirically
 * while building `task-worker.test.ts`'s own (SQLite, in-memory) test suite, where both a
 * file-backed multi-connection attempt and a shared-connection/multiple-wrapper-instances attempt
 * either hit "database is locked" or a real SQLite "cannot start a transaction within a
 * transaction" error. PostgreSQL's client-server architecture has no such limitation: each
 * `pool.connect()` call is a genuinely independent backend connection.
 *
 * HIGH-1: a claimed row's task execution must run on its OWN connection, never the dispatcher's
 * shared bookkeeping connection or another concurrently-running row's connection — otherwise one
 * task's `db.transaction()` call breaks every other concurrent operation sharing that connection.
 *
 * HIGH-2: per-task-id `concurrencyLimit` must hold across independent `TaskQueueDispatcher`
 * instances (simulating separate `minicoder tasks worker` processes), not just within one
 * process's in-memory `inFlight` map.
 */

const TEST_PG_URL = process.env['MINICODER_TEST_PG_URL'];
const RUN_PG = !!TEST_PG_URL;

const TEST_SCHEMA = 'minicoder_test_task_worker_concurrency';
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

function fakeDefinition(
  taskId: TaskId,
  concurrencyLimit: number,
  impl: (payload: unknown, db: DbClient) => Promise<unknown>,
): TaskDefinition<unknown, unknown> {
  return {
    taskId,
    concurrencyLimit,
    schema: z.object({ projectId: z.string() }) as unknown as TaskDefinition['schema'],
    impl: impl as TaskDefinition['impl'],
  };
}

/** Opens a genuine, independent pool connection per call — mirrors the production
 * `defaultRunWithTaskDb` shape exactly, just backed by a test-owned `Pool` instead of env vars. */
function poolRunWithTaskDb(pool: Pool) {
  return async <T>(fn: (taskDb: DbClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    const taskDb = new PostgresDbClient(client);
    try {
      return await fn(taskDb);
    } finally {
      await taskDb.close();
    }
  };
}

describe.skipIf(!RUN_PG)('TaskQueueDispatcher genuine multi-connection concurrency (PostgreSQL)', () => {
  let pool: Pool;
  let seq = 0;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: TEST_PG_URL! });
    await adminPool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await adminPool.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await adminPool.end();

    const url = new URL(TEST_PG_URL!);
    url.searchParams.set('options', `-c search_path="${TEST_SCHEMA}"`);
    pool = new Pool({ connectionString: url.toString() });

    await applyAllMigrations(pool);
    // task_queue.project_id and triggerdev_runs.project_id both carry a REFERENCES projects(id)
    // foreign key — seed the one project id every row in this suite uses.
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, $2)`, [
      'proj-pg-concurrency',
      'PG Concurrency Test Project',
    ]);
  });

  afterAll(async () => {
    await pool.end();
    const adminPool = new Pool({ connectionString: TEST_PG_URL! });
    await adminPool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await adminPool.end();
  });

  async function insertTaskQueueRow(taskId: string): Promise<string> {
    seq += 1;
    const id = `tq-pg-${seq}-${Date.now()}`;
    await pool.query(
      `INSERT INTO task_queue (id, task_id, payload, idempotency_key, status, attempts, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', 0, 1, NOW(), NOW())`,
      [id, taskId, JSON.stringify({ projectId: 'proj-pg-concurrency' }), `idem-${id}`],
    );
    return id;
  }

  async function countRows(status: string, taskId?: string): Promise<number> {
    const result = taskId
      ? await pool.query('SELECT COUNT(*) as count FROM task_queue WHERE status = $1 AND task_id = $2', [
          status,
          taskId,
        ])
      : await pool.query('SELECT COUNT(*) as count FROM task_queue WHERE status = $1', [status]);
    return Number(result.rows[0].count);
  }

  it('runs two concurrently-claimed tasks that each open a real db.transaction() without conflict', async () => {
    await insertTaskQueueRow('run-coder');
    await insertTaskQueueRow('run-review');

    const transactionalImpl = async (_payload: unknown, taskDb: DbClient) =>
      taskDb.transaction(async (tx) => {
        await new Promise((resolve) => setTimeout(resolve, 50)); // let the other task's impl overlap
        await tx.execute('SELECT 1');
        return { ok: true };
      });

    const bookkeepingClient = await pool.connect();
    const bookkeepingDb = new PostgresDbClient(bookkeepingClient);
    try {
      const dispatcher = new TaskQueueDispatcher(bookkeepingDb, {
        batchSize: 10,
        registry: new Map<TaskId, TaskDefinition<unknown, unknown>>([
          ['run-coder', fakeDefinition('run-coder', 1, transactionalImpl)],
          ['run-review', fakeDefinition('run-review', 1, transactionalImpl)],
        ]),
        runWithTaskDb: poolRunWithTaskDb(pool),
      });

      const result = await dispatcher.pollAndDispatch();
      expect(result.failed).toBe(0);
      expect(result.dispatched).toBe(2);
      expect(await countRows('succeeded')).toBeGreaterThanOrEqual(2);
    } finally {
      bookkeepingClient.release();
    }
  });

  it('enforces per-task concurrency across two independent dispatcher instances sharing one DB', async () => {
    await insertTaskQueueRow('run-merge-gate');
    await insertTaskQueueRow('run-merge-gate');

    let concurrent = 0;
    let maxConcurrent = 0;
    const slowImpl = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrent--;
      return { ok: true };
    };
    const registry = new Map<TaskId, TaskDefinition<unknown, unknown>>([
      ['run-merge-gate', fakeDefinition('run-merge-gate', 1, slowImpl)],
    ]);

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const dbA = new PostgresDbClient(clientA);
    const dbB = new PostgresDbClient(clientB);
    try {
      const dispatcherA = new TaskQueueDispatcher(dbA, { registry, runWithTaskDb: poolRunWithTaskDb(pool) });
      const dispatcherB = new TaskQueueDispatcher(dbB, { registry, runWithTaskDb: poolRunWithTaskDb(pool) });

      // A real worker loops repeatedly; with concurrencyLimit: 1, one row is expected to stay
      // `pending` on a given tick if the other is already `processing` on a concurrent tick, and
      // only get claimed on a later tick once the first finishes. Loop each dispatcher (like two
      // independent `minicoder tasks worker` processes polling on their own interval) until both
      // rows are drained, tracking dispatched totals and the true cross-instance concurrency peak.
      let totalDispatched = 0;
      for (let i = 0; i < 20 && totalDispatched < 2; i++) {
        const [resultA, resultB] = await Promise.all([
          dispatcherA.pollAndDispatch(),
          dispatcherB.pollAndDispatch(),
        ]);
        totalDispatched += resultA.dispatched + resultB.dispatched;
        if (totalDispatched < 2) await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Across BOTH dispatcher instances, at most 1 row for this concurrencyLimit: 1 task ever ran
      // at the same time — if the in-process-only `inFlight` map were the only guard, each
      // dispatcher's own independent map would allow 1 each, i.e. 2 concurrently.
      expect(maxConcurrent).toBeLessThanOrEqual(1);
      expect(totalDispatched).toBe(2);
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});
