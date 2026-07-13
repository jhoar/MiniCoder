/**
 * Trigger.dev replacement: the task-queue worker.
 *
 * `TaskQueueDispatcher` mirrors `packages/workflow/src/outbox/dispatcher.ts`'s `OutboxDispatcher`
 * shape closely (stale-claim recovery, atomic optimistic-lock claim, an awaited heartbeat loop
 * that re-touches `updated_at` while a task runs, exponential backoff on failure via the same
 * `deterministicBackoff()` helper) — reusing a pattern already proven in this codebase rather than
 * inventing a new one.
 *
 * One deliberate divergence from `OutboxDispatcher`: outbox events have no per-event-type
 * concurrency limit, so `OutboxDispatcher.pollAndDispatch()` processes its whole batch
 * sequentially. Trigger.dev's tasks each had their own `concurrencyLimit` (1 for most tasks, 5 for
 * a few) — reproducing that requires genuine within-tick concurrency.
 *
 * PR #75 review fix (HIGH-1): a claimed row's task execution (`runRegisteredTask`) runs against a
 * dedicated connection opened just for that row (`runWithTaskDb`), never against the dispatcher's
 * own shared `db`. Real task implementations commonly call `db.transaction()`
 * (`TransactionalCommandExecutor`); the persistence clients reject `query`/`execute`/
 * `executeAffected` calls on a `DbClient` instance while a transaction is active on that SAME
 * instance. Running multiple claimed rows' `runOne()` concurrently while they all shared one
 * `DbClient` meant one row's `db.transaction()` call would break every other concurrently-running
 * row's heartbeat (`this.db.executeAffected(...)`) on the same instance — reproduced locally
 * before this fix. The dispatcher's own bookkeeping (stale-claim recovery, candidate select,
 * heartbeat, mark-succeeded/failed, the `linked_run_id` backfill) continues to use the shared
 * `db`, which never itself opens a transaction, so concurrent heartbeats never conflict with it.
 *
 * PR #75 review fix (HIGH-2): per-task-id concurrency is enforced by a DB-backed claim, not only
 * the in-process `inFlight` map — see `attemptClaim()`'s doc comment. The in-process map remains
 * as a fast-path pre-filter (skip an obviously-futile claim attempt without a DB round trip) but
 * is no longer the source of truth, so running multiple `minicoder tasks worker` processes against
 * the same database now genuinely honors each task's configured `concurrencyLimit`.
 */
import type { DbClient } from '@minicoder/core';
import { parseJsonField, defaultRedactor } from '@minicoder/core';
import { deterministicBackoff } from '@minicoder/workflow';
import { TASK_REGISTRY, runRegisteredTask } from './task-registry.js';
import type { TaskDefinition } from './task-registry.js';
import type { TaskId } from './task-ids.js';
import { createDbClientFromEnv } from './db.js';

export interface TaskWorkerOptions {
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly staleClaimMs: number;
}

const DEFAULT_OPTIONS: TaskWorkerOptions = {
  batchSize: 10,
  maxAttempts: 3,
  baseBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  staleClaimMs: 300_000,
};

/** Opens a connection, runs `fn` against it, and always closes it afterward — the same
 * open/use/close-in-finally shape `default-task-trigger-client.ts`'s `enqueueTask()` already uses.
 * Each call is a fresh, independent connection: safe to invoke concurrently from multiple in-flight
 * tasks without any of them sharing transaction state with one another or with the dispatcher's own
 * bookkeeping connection. */
async function defaultRunWithTaskDb<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
  const db = await createDbClientFromEnv();
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

const MAX_ERROR_LENGTH = 2000;

function summarizeError(err: unknown): string {
  const raw = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const redacted = defaultRedactor.redact(raw);
  return redacted.length > MAX_ERROR_LENGTH ? redacted.slice(0, MAX_ERROR_LENGTH) : redacted;
}

export interface TaskQueueDispatcherOptions extends Partial<TaskWorkerOptions> {
  /** Injectable for tests, so a unit test can exercise claim/heartbeat/backoff/concurrency logic
   * against a small fake task definition instead of one of the 19 real runImpls. Production
   * callers never pass this — it defaults to the real, compile-time-fixed TASK_REGISTRY. */
  readonly registry?: ReadonlyMap<TaskId, TaskDefinition<unknown, unknown>>;
  /** Injectable for tests (see `defaultRunWithTaskDb`'s doc comment for the production default and
   * why task execution must never reuse the dispatcher's own shared `db`). Tests that use
   * DB-free fake task implementations can safely pass `async (fn) => fn(sharedTestDb)` — no
   * transaction is ever opened by those fakes, so there is nothing for a shared connection to
   * conflict with, and (per this repo's SQLite Test Teardown Rule) never calling `.close()` on a
   * test's own db avoids the native-finalizer double-free hazard. */
  readonly runWithTaskDb?: <T>(fn: (db: DbClient) => Promise<T>) => Promise<T>;
}

interface TaskQueueRow {
  id: string;
  task_id: string;
  payload: string;
  attempts: number;
  version: number;
}

function isoNow(): string {
  return new Date().toISOString();
}

export class TaskQueueDispatcher {
  private readonly options: TaskWorkerOptions;
  private readonly registry: ReadonlyMap<TaskId, TaskDefinition<unknown, unknown>>;
  private readonly runWithTaskDb: <T>(fn: (db: DbClient) => Promise<T>) => Promise<T>;
  private readonly inFlight = new Map<TaskId, number>();

  constructor(
    private readonly db: DbClient,
    options: TaskQueueDispatcherOptions = {},
  ) {
    const { registry, runWithTaskDb, ...workerOptions } = options;
    this.options = { ...DEFAULT_OPTIONS, ...workerOptions };
    this.registry = registry ?? TASK_REGISTRY;
    this.runWithTaskDb = runWithTaskDb ?? defaultRunWithTaskDb;
    const sc = this.options.staleClaimMs;
    if (!Number.isFinite(sc) || !Number.isInteger(sc) || sc < 2) {
      throw new Error(
        `staleClaimMs must be a finite integer >= 2 (got ${sc}). ` +
          `Values below 2 produce a zero-delay heartbeat spin loop AND make the stale-claim ` +
          `threshold fire immediately, reclaiming active claims.`,
      );
    }
  }

  async pollAndDispatch(): Promise<{ dispatched: number; failed: number }> {
    // Stale claim recovery: reset any rows stuck in 'processing' for too long — e.g. a worker
    // process that crashed mid-task.
    const staleThreshold = new Date(Date.now() - this.options.staleClaimMs).toISOString();
    await this.db.execute(
      `UPDATE task_queue SET status = 'pending', version = version + 1, updated_at = ?
       WHERE status = 'processing' AND updated_at <= ?`,
      [isoNow(), staleThreshold],
    );

    const now = isoNow();
    const candidates = await this.db.query<TaskQueueRow>(
      `SELECT id, task_id, payload, attempts, version
       FROM task_queue
       WHERE status IN ('pending', 'failed')
         AND attempts < ?
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`,
      [this.options.maxAttempts, now, this.options.batchSize],
    );

    let dispatched = 0;
    let failed = 0;
    const running: Promise<void>[] = [];

    for (const row of candidates) {
      const taskId = row.task_id as TaskId;
      const definition = this.registry.get(taskId);

      if (!definition) {
        // Unknown task_id (e.g. a stale row from a renamed/removed task) — push back by
        // maxBackoffMs, same as OutboxDispatcher's unknown-event-type handling. Attempts are NOT
        // incremented so the row would become eligible again if the task were ever re-registered.
        const nextRetryAt = new Date(Date.now() + this.options.maxBackoffMs).toISOString();
        await this.db.execute(
          `UPDATE task_queue SET next_retry_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
          [nextRetryAt, isoNow(), row.id, row.version],
        );
        continue;
      }

      const inFlightCount = this.inFlight.get(taskId) ?? 0;
      if (inFlightCount >= definition.concurrencyLimit) {
        // Fast local pre-filter only — avoids a wasted claim-transaction round trip when this
        // process already knows it's at capacity. The DB-backed check inside attemptClaim() is
        // what actually enforces the limit across every worker process.
        continue;
      }

      const claim = await this.attemptClaim(taskId, row, definition.concurrencyLimit);
      if (!claim.claimed) continue;

      this.inFlight.set(taskId, inFlightCount + 1);

      running.push(
        this.runOne(taskId, row, claim.claimedVersion).then((outcome) => {
          this.inFlight.set(taskId, (this.inFlight.get(taskId) ?? 1) - 1);
          if (outcome === 'dispatched') dispatched++;
          else if (outcome === 'failed') failed++;
        }),
      );
    }

    await Promise.all(running);
    return { dispatched, failed };
  }

  /**
   * Atomically checks the CURRENT count of `processing` rows for `taskId` against
   * `concurrencyLimit` and claims `row` only if under that limit — all inside one transaction on a
   * connection dedicated to this one claim attempt, so it can never be blocked by (or block) a
   * concurrently-running task's own transaction.
   *
   * A plain "count, then update" without a lock would race across processes: two concurrent
   * transactions could each read a count of 0 (PostgreSQL's READ COMMITTED default only sees
   * committed data from other transactions) and both proceed to claim a different row of the same
   * `concurrencyLimit: 1` task, since neither UPDATE conflicts at the row level (they target
   * different row ids). `task_concurrency_gates` exists purely to give this check something to
   * lock: `UPDATE task_concurrency_gates SET task_id = task_id WHERE task_id = ?` is a portable,
   * cross-dialect mutual-exclusion primitive — a real per-row lock in PostgreSQL, and (more
   * coarsely, but still correctly) SQLite's whole-database write lock, held for the rest of this
   * transaction. A second concurrent claim attempt for the same `taskId` blocks on this statement
   * until the first transaction commits or rolls back, so its own count read is guaranteed to see
   * the first attempt's outcome.
   */
  private async attemptClaim(
    taskId: TaskId,
    row: TaskQueueRow,
    concurrencyLimit: number,
  ): Promise<{ claimed: false } | { claimed: true; claimedVersion: number }> {
    return this.runWithTaskDb((claimDb) =>
      claimDb.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO task_concurrency_gates (task_id) VALUES (?) ON CONFLICT (task_id) DO NOTHING`,
          [taskId],
        );
        await tx.execute(`UPDATE task_concurrency_gates SET task_id = task_id WHERE task_id = ?`, [
          taskId,
        ]);
        const countRows = await tx.query<{ count: number }>(
          `SELECT COUNT(*) as count FROM task_queue WHERE task_id = ? AND status = 'processing'`,
          [taskId],
        );
        if ((countRows[0]?.count ?? 0) >= concurrencyLimit) {
          return { claimed: false as const };
        }
        const affected = await tx.executeAffected(
          `UPDATE task_queue SET status = 'processing', version = version + 1, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'failed') AND version = ?`,
          [isoNow(), row.id, row.version],
        );
        if (affected === 0) return { claimed: false as const };
        return { claimed: true as const, claimedVersion: row.version + 1 };
      }),
    );
  }

  /**
   * True when no row is currently processing and no row is still eligible for a future retry —
   * i.e. `pollAndDispatch()` has nothing left to do until a new row is enqueued. A row that has
   * permanently exhausted `maxAttempts` does NOT count as remaining work (it will never be picked
   * up again), which is exactly `pollAndDispatch()`'s own candidate-selection predicate mirrored
   * here — callers like `minicoder tasks drain` must use this instead of a naive
   * `status IN ('pending','processing')` check, which would miss a row sitting at `status =
   * 'failed'` with a future `next_retry_at` and falsely report the queue as drained.
   */
  async isEmpty(): Promise<boolean> {
    const rows = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM task_queue
       WHERE status = 'processing'
          OR (status IN ('pending', 'failed') AND attempts < ?)`,
      [this.options.maxAttempts],
    );
    return (rows[0]?.count ?? 0) === 0;
  }

  /** Runs one claimed row to completion, including its heartbeat loop. */
  private async runOne(
    taskId: TaskId,
    row: TaskQueueRow,
    claimedVersion: number,
  ): Promise<'dispatched' | 'failed' | 'lost'> {
    // Awaited heartbeat loop with a persistent cancellation flag — mirrors OutboxDispatcher's
    // exact shape (see that file for the "stale-cancel bug" this design avoids). Always runs
    // against the dispatcher's own shared `db`, never the per-task connection below — the shared
    // `db` never opens a transaction, so concurrent heartbeats from other in-flight rows can never
    // conflict with it.
    let stopped = false;
    let lostOwnership = false;
    let cancelTimer: () => void = () => {};
    const heartbeatDone = (async () => {
      const intervalMs = Math.max(1, Math.floor(this.options.staleClaimMs / 2));
      while (!stopped) {
        const timedOut = await new Promise<boolean>((resolve) => {
          const id = setTimeout(() => resolve(true), intervalMs);
          cancelTimer = () => {
            clearTimeout(id);
            resolve(false);
          };
        });
        if (!timedOut || stopped) break;
        try {
          const renewed = await this.db.executeAffected(
            `UPDATE task_queue SET updated_at = ? WHERE id = ? AND status = 'processing' AND version = ?`,
            [isoNow(), row.id, claimedVersion],
          );
          if (renewed === 0) {
            lostOwnership = true;
            break; // Row reclaimed by stale-claim recovery — stop heartbeating
          }
        } catch {
          lostOwnership = true;
          break;
        }
      }
    })();

    try {
      const payload = parseJsonField<unknown>(row.payload);
      await this.runWithTaskDb((taskDb) =>
        runRegisteredTask(taskId, payload, row.id, taskDb, this.registry),
      );
      stopped = true;
      cancelTimer();
      await heartbeatDone;
      if (lostOwnership) return 'lost';
      const succeededCount = await this.markSucceeded(row.id, claimedVersion);
      return succeededCount > 0 ? 'dispatched' : 'lost';
    } catch (err) {
      const nextAttempts = row.attempts + 1;
      const nextRetryMs = deterministicBackoff(
        nextAttempts,
        this.options.baseBackoffMs,
        this.options.maxBackoffMs,
      );
      const nextRetryAt = new Date(Date.now() + nextRetryMs).toISOString();
      stopped = true;
      cancelTimer();
      await heartbeatDone;
      if (lostOwnership) return 'lost';
      const failedCount = await this.markFailed(
        row.id,
        nextAttempts,
        nextRetryAt,
        claimedVersion,
        summarizeError(err),
      );
      return failedCount > 0 ? 'failed' : 'lost';
    } finally {
      stopped = true;
      cancelTimer();
      await heartbeatDone;
      // Best-effort back-reference from task_queue to the triggerdev_runs row runRegisteredTask
      // just wrote/updated (keyed by triggerdev_run_id = row.id) — purely a debugging/inspection
      // convenience; failure here must never affect the retry/backoff outcome above.
      try {
        await this.db.execute(
          `UPDATE task_queue SET linked_run_id = (SELECT id FROM triggerdev_runs WHERE triggerdev_run_id = ?) WHERE id = ?`,
          [row.id, row.id],
        );
      } catch {
        // Non-fatal — linked_run_id is a convenience column, not load-bearing.
      }
    }
  }

  private async markSucceeded(id: string, claimedVersion: number): Promise<number> {
    return this.db.executeAffected(
      `UPDATE task_queue SET status = 'succeeded', error = NULL, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      [isoNow(), id, claimedVersion],
    );
  }

  private async markFailed(
    id: string,
    attempts: number,
    nextRetryAt: string,
    claimedVersion: number,
    error: string,
  ): Promise<number> {
    return this.db.executeAffected(
      `UPDATE task_queue SET status = 'failed', attempts = ?, next_retry_at = ?, error = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      [attempts, nextRetryAt, error, isoNow(), id, claimedVersion],
    );
  }
}
