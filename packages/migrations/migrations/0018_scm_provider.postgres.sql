-- docs/06-implementation-plan.md Phase 18 Stage 2 ("Generic SCM Interface"): see the SQLite
-- migration's header comment for the full rationale.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS base_url TEXT;

CREATE INDEX IF NOT EXISTS idx_repositories_full_name_provider ON repositories(full_name, provider);

ALTER TABLE github_links RENAME TO scm_links;

-- Postgres does not rename an index when its underlying table is renamed either -- recreate it
-- under the new table's name rather than leaving a stale idx_github_links_* name pointing at
-- scm_links.
DROP INDEX IF EXISTS idx_github_links_project_id;
CREATE INDEX IF NOT EXISTS idx_scm_links_project_id ON scm_links(project_id);
