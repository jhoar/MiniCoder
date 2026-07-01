-- Preflight: if duplicate default (project_id IS NULL) or duplicate project-scoped rows exist
-- for the same adapter, this migration will fail with a unique constraint violation (23505).
-- Identify duplicate default rows with:
--   SELECT adapter_id, COUNT(*) n FROM agent_configurations
--     WHERE project_id IS NULL GROUP BY adapter_id HAVING COUNT(*) > 1;
-- Identify duplicate project-scoped rows with:
--   SELECT adapter_id, project_id, COUNT(*) n FROM agent_configurations
--     WHERE project_id IS NOT NULL GROUP BY adapter_id, project_id HAVING COUNT(*) > 1;
-- Keep the most-recently-updated row per group and remove the others, e.g. for default rows:
--   DELETE FROM agent_configurations WHERE id NOT IN (
--     SELECT DISTINCT ON (adapter_id) id FROM agent_configurations
--       WHERE project_id IS NULL ORDER BY adapter_id, updated_at DESC
--   ) AND project_id IS NULL;
-- (repeat the analogous DELETE for project-scoped rows, DISTINCT ON (adapter_id, project_id))
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_configurations_default
  ON agent_configurations (adapter_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_configurations_project
  ON agent_configurations (adapter_id, project_id) WHERE project_id IS NOT NULL;
