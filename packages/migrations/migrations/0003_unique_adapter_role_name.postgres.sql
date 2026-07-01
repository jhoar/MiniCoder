-- Preflight: if any duplicate (role, name) pairs exist this migration will fail with a
-- unique constraint violation (error code 23505). Before applying, identify duplicates with:
--   SELECT role, name, COUNT(*) n FROM agent_adapters GROUP BY role, name HAVING COUNT(*) > 1;
-- Keep the most-recently-updated row per pair and remove the others:
--   DELETE FROM agent_adapters WHERE id NOT IN (
--     SELECT DISTINCT ON (role, name) id FROM agent_adapters ORDER BY role, name, updated_at DESC
--   );
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_adapters_role_name ON agent_adapters (role, name);
