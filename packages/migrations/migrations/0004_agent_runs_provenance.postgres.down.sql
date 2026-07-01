ALTER TABLE agent_runs DROP COLUMN IF EXISTS adapter_name;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS adapter_implementation;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS adapter_version;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS capabilities_used;
