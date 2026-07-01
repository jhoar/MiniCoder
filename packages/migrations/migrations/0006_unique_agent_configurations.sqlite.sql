-- Preflight: if duplicate default (project_id IS NULL) or duplicate project-scoped rows exist
-- for the same adapter, this migration will fail with a "UNIQUE constraint failed" error.
-- Identify duplicate default rows with:
--   SELECT adapter_id, COUNT(*) n FROM agent_configurations
--     WHERE project_id IS NULL GROUP BY adapter_id HAVING COUNT(*) > 1;
-- Identify duplicate project-scoped rows with:
--   SELECT adapter_id, project_id, COUNT(*) n FROM agent_configurations
--     WHERE project_id IS NOT NULL GROUP BY adapter_id, project_id HAVING COUNT(*) > 1;
-- Keep the most-recently-updated row per group and remove the others (MAX(rowid) is NOT
-- equivalent to "most recently updated" — rowid reflects insertion order, not updated_at).
-- For default rows:
--   DELETE FROM agent_configurations WHERE id NOT IN (
--     SELECT id FROM (
--       SELECT id, ROW_NUMBER() OVER (
--         PARTITION BY adapter_id ORDER BY updated_at DESC, id DESC
--       ) rn FROM agent_configurations WHERE project_id IS NULL
--     ) WHERE rn = 1
--   ) AND project_id IS NULL;
-- For project-scoped rows (partition by adapter_id, project_id instead):
--   DELETE FROM agent_configurations WHERE id NOT IN (
--     SELECT id FROM (
--       SELECT id, ROW_NUMBER() OVER (
--         PARTITION BY adapter_id, project_id ORDER BY updated_at DESC, id DESC
--       ) rn FROM agent_configurations WHERE project_id IS NOT NULL
--     ) WHERE rn = 1
--   ) AND project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_configurations_default
  ON agent_configurations (adapter_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_configurations_project
  ON agent_configurations (adapter_id, project_id) WHERE project_id IS NOT NULL;
