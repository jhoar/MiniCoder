-- Issue #67: see the SQLite migration's header comment for the full rationale.
CREATE TABLE observability_export_cursors (
  id             TEXT        PRIMARY KEY,
  last_event_id  TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
