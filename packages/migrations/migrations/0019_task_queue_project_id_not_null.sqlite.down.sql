-- Reverts migration 0019: restores task_queue.project_id to nullable (its original migration
-- 0017 shape). No data loss on the way back -- relaxing a NOT NULL constraint to nullable never
-- rejects existing data, so this needs no DELETE step the way the up-migration did.
CREATE TABLE task_queue_new (
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

INSERT INTO task_queue_new SELECT * FROM task_queue;

DROP TABLE task_queue;
ALTER TABLE task_queue_new RENAME TO task_queue;

CREATE INDEX idx_task_queue_status_next_retry_at ON task_queue(status, next_retry_at);
CREATE INDEX idx_task_queue_task_id ON task_queue(task_id);
