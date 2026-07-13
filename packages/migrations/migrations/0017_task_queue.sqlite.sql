-- Trigger.dev replacement: the in-repo task queue driving `packages/triggerdev/src/task-worker.ts`'s
-- `TaskQueueDispatcher`, mirroring `outbox_events`' shape (status/attempts/next_retry_at/version)
-- rather than inventing a new retry idiom. This is deliberately a NEW table, not a repurposing of
-- `triggerdev_runs` (migration 0001): `triggerdev_runs` is a stable, already-public status
-- read-model (`GET /triggerdev-runs`, consumed by the Text UI and Web UI) that has no reason to
-- carry queue-mechanics columns (`payload`, `attempts`, `next_retry_at`, `idempotency_key`) --
-- this table is worker-owned queue state, `triggerdev_runs` stays status-history-owned.
--
-- `idempotency_key` dedup is the mechanism replacing Trigger.dev's server-side run dedup:
-- `INSERT ... ON CONFLICT(project_id, task_id, idempotency_key) DO NOTHING` then re-SELECT on
-- conflict is the same claim-first idiom `packages/api/src/route-idempotency.ts` already uses for
-- route-level idempotency. Uniqueness is scoped to `(project_id, task_id, idempotency_key)`, not
-- `idempotency_key` alone (PR #75 review fix, MEDIUM-1: task_id; round-2 review fix, HIGH-2:
-- project_id): a caller-supplied key is only meant to dedup retries of the SAME logical task
-- invocation for the SAME project. A `(task_id, idempotency_key)`-only constraint still let two
-- different PROJECTS enqueuing the same task with the same key collide -- the second project's
-- enqueue would silently return the first project's unrelated row id instead of enqueuing its own
-- task. Every canonical task payload extends `BasePayload`, which requires a non-optional
-- `projectId: z.string()` (`packages/triggerdev/src/tasks/types.ts`), so every real row has a
-- non-NULL `project_id` in practice -- this widening does not need a partial-index NULL-handling
-- trick the way `agent_configurations`' two-index split does for a column NULL is a legitimate,
-- common case for.
--
-- `linked_run_id` is a nullable forward reference to the `triggerdev_runs` row created once the
-- worker claims this row and calls `linkRunToDb()` -- it stays NULL for a row that is still
-- pending/never claimed.
--
-- PR #75 round-2 re-review (HIGH-1) suggested a new migration (e.g. 0018) for these fixes instead
-- of editing 0017 in place, out of concern that a DB which already applied an earlier revision of
-- this file would not receive the new column/constraint. This repo's own established convention
-- (see CLAUDE.md's migration-editing-convention notes, and e.g. migration 0015's identical
-- round-3 PR #73 fix) is that editing an UNMERGED migration in place is safe and expected --
-- only a MERGED migration must never be edited in place. This PR has not merged, so no production
-- deployment has ever applied a prior revision of 0017; the only affected case is a developer who
-- checked out an earlier commit of THIS SAME PR, migrated, then pulled again mid-review -- a
-- disposable dev/test/CI database in active development, not a compatibility gap that will ever
-- exist post-merge. Once merged, this file is fixed at this shape forever.
CREATE TABLE task_queue (
  id               TEXT    PRIMARY KEY,
  task_id          TEXT    NOT NULL,
  payload          TEXT    NOT NULL,
  idempotency_key  TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_retry_at    TEXT,
  project_id       TEXT    REFERENCES projects(id),
  linked_run_id    TEXT    REFERENCES triggerdev_runs(id),
  error            TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (project_id, task_id, idempotency_key)
);

-- Poll query shape: `status IN ('pending','failed') AND attempts < ? AND (next_retry_at IS NULL
-- OR next_retry_at <= ?) ORDER BY created_at ASC` -- status is the leading filter, next_retry_at
-- the range filter within it.
CREATE INDEX idx_task_queue_status_next_retry_at ON task_queue(status, next_retry_at);
-- Per-task-id concurrency accounting (`TaskQueueDispatcher`'s claim transaction needs to find "how
-- many of task X are currently processing" quickly).
CREATE INDEX idx_task_queue_task_id ON task_queue(task_id);

-- PR #75 review fix (HIGH-2): a lockable anchor row per task_id, used only as a portable
-- cross-dialect mutual-exclusion primitive during the claim transaction -- see
-- `TaskQueueDispatcher.attemptClaim()`'s doc comment. Rows are created lazily (`INSERT ... ON
-- CONFLICT DO NOTHING`) the first time a task_id is claimed, rather than pre-seeded here, so this
-- table never needs to know the canonical task-id list.
CREATE TABLE task_concurrency_gates (
  task_id TEXT PRIMARY KEY
);
