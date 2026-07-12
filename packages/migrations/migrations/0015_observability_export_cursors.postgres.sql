-- Issue #67 / PR #73 review fix (round 2, MEDIUM-2): see the SQLite migration's header comment
-- for the full rationale.
CREATE TABLE observability_export_cursors (
  id                TEXT        PRIMARY KEY,
  last_event_id     TEXT,
  last_occurred_at  TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
