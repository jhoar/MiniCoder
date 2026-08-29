-- Issue #77: task_queue.project_id was nullable at the schema level despite being a de facto
-- required invariant since migration 0017 -- every canonical task payload extends BasePayload,
-- which requires a non-optional projectId: z.string() (packages/triggerdev/src/tasks/types.ts),
-- and every real production writer (packages/api/src/default-task-trigger-client.ts's
-- enqueueTask(), packages/cli/src/commands/trigger.ts's replay-run) already populates it. A NULL
-- project_id would silently defeat the (project_id, task_id, idempotency_key) composite unique
-- index's dedup guarantee -- SQL treats every NULL as distinct, so two NULL-project_id rows for
-- the same (task_id, idempotency_key) would never collide, reopening the exact "different
-- callers, same key" ambiguity project-scoping exists to close.
--
-- Any pre-existing NULL-project_id row can only have come from a bug or a manual/test insert that
-- bypassed both production writers -- task_queue is worker-owned queue-mechanics state (migration
-- 0017's own header comment), not a permanent record, and a row with no project_id has no external
-- identity a caller could be relying on (every project-scoped read/CLI/API path filters or joins
-- by project_id, so such a row is already unreachable through any real path). Deleting such rows
-- here, rather than rejecting the migration outright, mirrors the operational posture this repo
-- already takes for orphaned rows elsewhere (`state reconcile`/`state doctor`'s stuck-row cleanup).
--
-- SQLite has no ALTER COLUMN -- adding a NOT NULL constraint to an existing column requires the
-- documented rebuild procedure (create the new table, copy rows across, drop the old table, rename
-- the new one into place), per SQLite's own "Making Other Kinds Of Table Schema Changes"
-- documentation. Column order below matches migration 0017's original CREATE TABLE exactly, since
-- `INSERT ... SELECT *` relies on positional order between the two table shapes.
DELETE FROM task_queue WHERE project_id IS NULL;

CREATE TABLE task_queue_new (
  id               TEXT    PRIMARY KEY,
  task_id          TEXT    NOT NULL,
  payload          TEXT    NOT NULL,
  idempotency_key  TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_retry_at    TEXT,
  project_id       TEXT    NOT NULL REFERENCES projects(id),
  linked_run_id    TEXT    REFERENCES triggerdev_runs(id),
  error            TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (project_id, task_id, idempotency_key)
);

INSERT INTO task_queue_new SELECT * FROM task_queue;

DROP TABLE task_queue;
ALTER TABLE task_queue_new RENAME TO task_queue;

-- Recreate the indexes dropped along with the old table (SQLite does not carry indexes over a
-- table rename the way it would for a plain column add).
CREATE INDEX idx_task_queue_status_next_retry_at ON task_queue(status, next_retry_at);
CREATE INDEX idx_task_queue_task_id ON task_queue(task_id);
