-- Immutable adapter snapshot per run: name, implementation, version, and capabilities as recorded
-- at execution time. Decouples historical run provenance from mutable agent_adapter rows so that
-- re-registering an adapter does not alter the audit record of prior runs.
ALTER TABLE agent_runs ADD COLUMN adapter_name TEXT;
ALTER TABLE agent_runs ADD COLUMN adapter_implementation TEXT;
ALTER TABLE agent_runs ADD COLUMN adapter_version INTEGER;
ALTER TABLE agent_runs ADD COLUMN capabilities_used TEXT;
