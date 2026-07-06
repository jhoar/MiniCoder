ALTER TABLE agent_runs DROP COLUMN adapter_revision_id;
DROP INDEX IF EXISTS idx_adapter_revisions_adapter_id_version;
DROP INDEX IF EXISTS idx_adapter_revisions_adapter_id;
DROP TABLE IF EXISTS adapter_revisions;
