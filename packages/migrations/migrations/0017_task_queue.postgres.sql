-- Trigger.dev replacement: see the SQLite migration's header comment for the full rationale.
CREATE TABLE task_queue (
  id               TEXT        PRIMARY KEY,
  task_id          TEXT        NOT NULL,
  payload          JSONB       NOT NULL,
  idempotency_key  TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending',
  attempts         INTEGER     NOT NULL DEFAULT 0,
  next_retry_at    TIMESTAMPTZ,
  project_id       TEXT        REFERENCES projects(id),
  linked_run_id    TEXT        REFERENCES triggerdev_runs(id),
  error            TEXT,
  version          INTEGER     NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, task_id, idempotency_key)
);

CREATE INDEX idx_task_queue_status_next_retry_at ON task_queue(status, next_retry_at);
CREATE INDEX idx_task_queue_task_id ON task_queue(task_id);

-- PR #75 review fix (HIGH-2): see the SQLite migration's header comment for the full rationale.
CREATE TABLE task_concurrency_gates (
  task_id TEXT PRIMARY KEY
);
