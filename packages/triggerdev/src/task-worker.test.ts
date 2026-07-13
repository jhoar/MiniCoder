import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { DbClient } from '@minicoder/core';
import { SqliteDbClient } from '@minicoder/persistence-sqlite';
import { z } from 'zod';
import { TaskQueueDispatcher } from './task-worker.js';
import type { TaskDefinition } from './task-registry.js';
import type { TaskId } from './task-ids.js';
import { createTestDb, insertTestProject } from './test-helpers.js';

let db: SqliteDbClient;
let raw: Database.Database;

function setup(): void {
  db = createTestDb();
  raw = (db as unknown as { db: Database.Database }).db;
  insertTestProject(db);
}

/** A fresh `SqliteDbClient` wrapper per call, sharing the same underlying in-memory connection
 * (`raw`) as the test's own `db` — genuinely separate connections aren't possible for a
 * `:memory:` database, but each wrapper tracks its OWN `inTransaction` flag independently, so a
 * claim-transaction on one wrapper never trips another concurrently-running wrapper's
 * "cannot call X while a transaction is active" guard (confirmed necessary: a single shared
 * wrapper instance across concurrent claim + task-execution calls reproduced exactly that error).
 * Per this repo's SQLite Test Teardown Rule, never calls `.close()` (which would close the shared
 * underlying connection out from under the test's own `db`/`raw`). */
async function reuseSharedDb<T>(fn: (taskDb: DbClient) => Promise<T>): Promise<T> {
  return fn(new SqliteDbClient(raw));
}

afterEach(() => {
  vi.restoreAllMocks();
});

function insertTaskQueueRow(
  id: string,
  taskId: string,
  opts: { status?: string; attempts?: number; nextRetryAt?: string | null } = {},
): void {
  raw
    .prepare(
      `INSERT INTO task_queue (id, task_id, payload, idempotency_key, status, attempts, next_retry_at, version, created_at, updated_at)
       VALUES (?, ?, '{"projectId":"proj-test-001"}', ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .run(
      id,
      taskId,
      `idem-${id}`,
      opts.status ?? 'pending',
      opts.attempts ?? 0,
      opts.nextRetryAt ?? null,
    );
}

/** Fake task definition — lets these tests exercise claim/heartbeat/backoff/concurrency logic
 * without invoking one of the 19 real runImpls. */
function fakeDefinition(
  taskId: TaskId,
  concurrencyLimit: number,
  impl: (payload: unknown, db: unknown) => Promise<unknown>,
): TaskDefinition<unknown, unknown> {
  return {
    taskId,
    concurrencyLimit,
    schema: z.object({ projectId: z.string() }) as unknown as TaskDefinition['schema'],
    impl: impl as TaskDefinition['impl'],
  };
}

describe('TaskQueueDispatcher', () => {
  it('dispatches a pending task and marks it succeeded', async () => {
    setup();
    insertTaskQueueRow('tq-1', 'run-coder');
    const implFn = vi.fn().mockResolvedValue({ ok: true });
    const dispatcher = new TaskQueueDispatcher(db, {
      registry: new Map([['run-coder', fakeDefinition('run-coder', 1, implFn)]]),
      runWithTaskDb: reuseSharedDb,
    });

    const result = await dispatcher.pollAndDispatch();
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    expect(implFn).toHaveBeenCalledOnce();

    const row = raw.prepare('SELECT status, error FROM task_queue WHERE id = ?').get('tq-1') as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe('succeeded');
    expect(row.error).toBeNull();
  });

  it('increments attempts, sets next_retry_at, and persists a redacted error summary on impl failure', async () => {
    setup();
    insertTaskQueueRow('tq-2', 'run-coder');
    const implFn = vi
      .fn()
      .mockRejectedValue(
        new Error('boom: Authorization: Bearer super-secret-value-should-be-redacted'),
      );
    const dispatcher = new TaskQueueDispatcher(db, {
      baseBackoffMs: 1000,
      registry: new Map([['run-coder', fakeDefinition('run-coder', 1, implFn)]]),
      runWithTaskDb: reuseSharedDb,
    });

    const result = await dispatcher.pollAndDispatch();
    expect(result.failed).toBe(1);

    const row = raw
      .prepare('SELECT status, attempts, next_retry_at, error FROM task_queue WHERE id = ?')
      .get('tq-2') as {
      status: string;
      attempts: number;
      next_retry_at: string;
      error: string | null;
    };
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.next_retry_at).toBeTruthy();
    expect(row.error).toContain('boom');
    expect(row.error).not.toContain('super-secret-value-should-be-redacted');
  });

  it('requeues rows with an unregistered task_id for later retry, without incrementing attempts', async () => {
    setup();
    insertTaskQueueRow('tq-3', 'some-removed-task');
    const dispatcher = new TaskQueueDispatcher(db, {
      registry: new Map(),
      runWithTaskDb: reuseSharedDb,
    });

    const result = await dispatcher.pollAndDispatch();
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(0);

    const row = raw
      .prepare('SELECT status, attempts, next_retry_at FROM task_queue WHERE id = ?')
      .get('tq-3') as { status: string; attempts: number; next_retry_at: string | null };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.next_retry_at).toBeTruthy();
  });

  it('does not re-dispatch rows that have reached maxAttempts', async () => {
    setup();
    insertTaskQueueRow('tq-4', 'run-coder', { status: 'failed', attempts: 3 });
    const implFn = vi.fn().mockResolvedValue({ ok: true });
    const dispatcher = new TaskQueueDispatcher(db, {
      maxAttempts: 3,
      registry: new Map([['run-coder', fakeDefinition('run-coder', 1, implFn)]]),
      runWithTaskDb: reuseSharedDb,
    });

    await dispatcher.pollAndDispatch();
    expect(implFn).not.toHaveBeenCalled();
  });

  it('stale-claim recovery resets stuck processing rows so they are re-dispatched', async () => {
    setup();
    insertTaskQueueRow('tq-5', 'run-coder', { status: 'processing' });
    raw
      .prepare(`UPDATE task_queue SET updated_at = datetime('now', '-1 hour') WHERE id = ?`)
      .run('tq-5');
    const implFn = vi.fn().mockResolvedValue({ ok: true });
    const dispatcher = new TaskQueueDispatcher(db, {
      staleClaimMs: 1000,
      registry: new Map([['run-coder', fakeDefinition('run-coder', 1, implFn)]]),
      runWithTaskDb: reuseSharedDb,
    });

    const result = await dispatcher.pollAndDispatch();
    expect(result.dispatched).toBe(1);
    expect(implFn).toHaveBeenCalledOnce();
  });

  it('honors per-task-id concurrency limits: only concurrencyLimit rows run per tick', async () => {
    setup();
    insertTaskQueueRow('tq-6a', 'ingest-specification');
    insertTaskQueueRow('tq-6b', 'ingest-specification');
    insertTaskQueueRow('tq-6c', 'ingest-specification');
    let concurrent = 0;
    let maxConcurrent = 0;
    const implFn = vi.fn().mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent--;
      return { ok: true };
    });
    const dispatcher = new TaskQueueDispatcher(db, {
      batchSize: 10,
      registry: new Map([
        ['ingest-specification', fakeDefinition('ingest-specification', 2, implFn)],
      ]),
      runWithTaskDb: reuseSharedDb,
    });

    const result = await dispatcher.pollAndDispatch();
    // Only 2 of the 3 pending rows were within the concurrency-2 cap this tick; the third stays
    // pending, unclaimed, for the next poll.
    expect(result.dispatched).toBe(2);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    const remaining = raw
      .prepare(`SELECT COUNT(*) as count FROM task_queue WHERE status = 'pending'`)
      .get() as { count: number };
    expect(remaining.count).toBe(1);
  });

  it('rejects a non-integer or sub-2 staleClaimMs', () => {
    setup();
    expect(() => new TaskQueueDispatcher(db, { staleClaimMs: 1 })).toThrow(/staleClaimMs/);
    expect(() => new TaskQueueDispatcher(db, { staleClaimMs: NaN })).toThrow(/staleClaimMs/);
  });
});

// PR #75 review fixes (HIGH-1 concurrent-transaction isolation, HIGH-2 cross-process concurrency
// enforcement): both are verified in `task-worker-concurrency.postgres.test.ts`, gated by
// `MINICODER_TEST_PG_URL`, NOT here. better-sqlite3 is a fully synchronous native binding on
// Node's single thread — two genuinely separate `SqliteDbClient` connections to the same file
// cannot truly overlap (confirmed empirically while building these tests: both a file-backed
// multi-connection version of this test and a shared-connection/multiple-wrapper-instances version
// either hit "database is locked" or a real SQLite "cannot start a transaction within a
// transaction" error, since a single physical SQLite connection only ever supports one open
// transaction regardless of how many `SqliteDbClient` wrapper instances address it). This is the
// exact same finding already documented in
// `packages/testing/src/execution-orchestrator-concurrency.postgres.test.ts`'s own doc comment.
// PostgreSQL's client-server architecture has no such limitation, so that is where this repo's
// established convention already puts genuine concurrent-connection regression tests.
