-- Trigger.dev replacement: the in-repo task queue driving `packages/triggerdev/src/task-worker.ts`'s
-- `TaskQueueDispatcher`, mirroring `outbox_events`' shape (status/attempts/next_retry_at/version)
-- rather than inventing a new retry idiom. This is deliberately a NEW table, not a repurposing of
-- `triggerdev_runs` (migration 0001): `triggerdev_runs` is a stable, already-public status
-- read-model (`GET /triggerdev-runs`, consumed by the Text UI and Web UI) that has no reason to
-- carry queue-mechanics columns (`payload`, `attempts`, `next_retry_at`, `idempotency_key`) --
-- this table is worker-owned queue state, `triggerdev_runs` stays status-history-owned.
--
-- `idempotency_key` is UNIQUE and is the dedup mechanism replacing Trigger.dev's server-side run
-- dedup: `INSERT ... ON CONFLICT(idempotency_key) DO NOTHING` then re-SELECT on conflict is the
-- same claim-first idiom `packages/api/src/route-idempotency.ts` already uses for route-level
-- idempotency.
--
-- `linked_run_id` is a nullable forward reference to the `triggerdev_runs` row created once the
-- worker claims this row and calls `linkRunToDb()` -- it stays NULL for a row that is still
-- pending/never claimed.
CREATE TABLE task_queue (
  id               TEXT    PRIMARY KEY,
  task_id          TEXT    NOT NULL,
  payload          TEXT    NOT NULL,
  idempotency_key  TEXT    NOT NULL UNIQUE,
  status           TEXT    NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_retry_at    TEXT,
  project_id       TEXT    REFERENCES projects(id),
  linked_run_id    TEXT    REFERENCES triggerdev_runs(id),
  error            TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Poll query shape: `status IN ('pending','failed') AND attempts < ? AND (next_retry_at IS NULL
-- OR next_retry_at <= ?) ORDER BY created_at ASC` -- status is the leading filter, next_retry_at
-- the range filter within it.
CREATE INDEX idx_task_queue_status_next_retry_at ON task_queue(status, next_retry_at);
-- Per-task-id concurrency accounting (`TaskQueueDispatcher`'s in-process in-flight-count map needs
-- to find "how many of task X are currently processing/pending" quickly).
CREATE INDEX idx_task_queue_task_id ON task_queue(task_id);
