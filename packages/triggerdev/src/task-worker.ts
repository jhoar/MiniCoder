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
 * a few) — reproducing that requires genuine within-tick concurrency, bounded per task_id by an
 * in-process `Map<TaskId, number>` of in-flight counts that persists across polls (a single Node
 * worker process serves the whole queue, so no cross-process coordination is needed to honor it).
 */
import type { DbClient } from '@minicoder/core';
import { parseJsonField } from '@minicoder/core';
import { deterministicBackoff } from '@minicoder/workflow';
import { TASK_REGISTRY, runRegisteredTask } from './task-registry.js';
import type { TaskDefinition } from './task-registry.js';
import type { TaskId } from './task-ids.js';

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
  private readonly inFlight = new Map<TaskId, number>();

  constructor(
    private readonly db: DbClient,
    options: Partial<TaskWorkerOptions> = {},
    // Injectable for tests, so a unit test can exercise claim/heartbeat/backoff/concurrency logic
    // against a small fake task definition instead of one of the 19 real runImpls. Production
    // callers never pass this — it defaults to the real, compile-time-fixed TASK_REGISTRY.
    private readonly registry: ReadonlyMap<
      TaskId,
      TaskDefinition<unknown, unknown>
    > = TASK_REGISTRY,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    const sc = this.options.staleClaimMs;
    if (!Number.isFinite(sc) || !Number.isInteger(sc) || sc < 2) {
      throw new Error(
        `staleClaimMs must be a finite integer >= 2 (got ${sc}). ` +
          `Values below 2 produce a zero-delay heartbeat loop AND make the stale-claim ` +
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
        // At capacity for this task_id — leave the row unclaimed for a later poll tick.
        continue;
      }

      // Atomic claim: include version = ? so claimedVersion = row.version + 1 is always accurate.
      const claimed = await this.db.executeAffected(
        `UPDATE task_queue SET status = 'processing', version = version + 1, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'failed') AND version = ?`,
        [isoNow(), row.id, row.version],
      );
      if (claimed === 0) continue;

      const claimedVersion = row.version + 1;
      this.inFlight.set(taskId, inFlightCount + 1);

      running.push(
        this.runOne(taskId, row, claimedVersion).then((outcome) => {
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
    // exact shape (see that file for the "stale-cancel bug" this design avoids).
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
      await runRegisteredTask(taskId, payload, row.id, this.db, this.registry);
      stopped = true;
      cancelTimer();
      await heartbeatDone;
      if (lostOwnership) return 'lost';
      const succeededCount = await this.markSucceeded(row.id, claimedVersion);
      return succeededCount > 0 ? 'dispatched' : 'lost';
    } catch {
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
      const failedCount = await this.markFailed(row.id, nextAttempts, nextRetryAt, claimedVersion);
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
      `UPDATE task_queue SET status = 'succeeded', version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      [isoNow(), id, claimedVersion],
    );
  }

  private async markFailed(
    id: string,
    attempts: number,
    nextRetryAt: string,
    claimedVersion: number,
  ): Promise<number> {
    return this.db.executeAffected(
      `UPDATE task_queue SET status = 'failed', attempts = ?, next_retry_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      [attempts, nextRetryAt, isoNow(), id, claimedVersion],
    );
  }
}
