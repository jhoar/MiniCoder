-- Issue #26: agent_adapters/agent_capabilities are mutable operational registry state --
-- AdapterRegistry.register() replaces capabilities and increments version in place on every
-- re-registration. That means a historical agent_runs row's adapter_id/adapter_version alone
-- cannot reconstruct "what capability set was actually declared at the moment this run
-- happened" once a later re-registration has overwritten agent_capabilities -- the join target
-- has moved on.
--
-- adapter_revisions is an append-only audit log: one row per register() call (initial insert or
-- version-bump update), snapshotting the full declared capability set as it was at that exact
-- version. agent_runs.adapter_revision_id (added below) points each run at the exact revision
-- active when it was recorded, independent of any later re-registration. This is immutable audit
-- provenance, distinct from agent_adapters/agent_capabilities' current operational registry
-- state -- the same distinction this schema already draws for adapter_conformance_results
-- (historical audit log) vs. agent_configurations (current resolved config).
CREATE TABLE adapter_revisions (
  id             TEXT    PRIMARY KEY,
  adapter_id     TEXT    NOT NULL REFERENCES agent_adapters(id) ON DELETE CASCADE,
  role           TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  implementation TEXT    NOT NULL,
  version        INTEGER NOT NULL,
  capabilities   TEXT    NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_adapter_revisions_adapter_id ON adapter_revisions(adapter_id);
CREATE INDEX idx_adapter_revisions_adapter_id_version ON adapter_revisions(adapter_id, version);

ALTER TABLE agent_runs ADD COLUMN adapter_revision_id TEXT REFERENCES adapter_revisions(id);
