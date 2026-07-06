-- Issue #26: see the SQLite migration's header comment for the full rationale.
CREATE TABLE adapter_revisions (
  id             TEXT        PRIMARY KEY,
  adapter_id     TEXT        NOT NULL REFERENCES agent_adapters(id) ON DELETE CASCADE,
  role           TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  implementation TEXT        NOT NULL,
  version        INTEGER     NOT NULL,
  capabilities   JSONB       NOT NULL,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_adapter_revisions_adapter_id ON adapter_revisions(adapter_id);
CREATE INDEX idx_adapter_revisions_adapter_id_version ON adapter_revisions(adapter_id, version);

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS adapter_revision_id TEXT REFERENCES adapter_revisions(id);
