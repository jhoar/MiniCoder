-- docs/06-implementation-plan.md Phase 18 Stage 2 ("Generic SCM Interface"): additive schema
-- support for SCM providers beyond GitHub, behind the ScmClient seam renamed in Stage 1.
--
-- `provider` defaults every existing row to 'github' -- the only provider any deployment could
-- have been using before this migration -- so no backfill is needed and no existing GitHub-only
-- deployment is affected. `base_url` is nullable: github.com needs none; a self-hosted GitLab/Gitea
-- instance sets it. Both are consumed by resolveProjectId() (packages/github/src/webhook-app.ts),
-- which now scopes its repositories lookup by provider as well as full_name, since owner/repo
-- strings are no longer guaranteed unique across providers once a second one exists.
ALTER TABLE repositories ADD COLUMN provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE repositories ADD COLUMN base_url TEXT;

-- Supports the new WHERE full_name = ? AND provider = ? lookup shape directly -- and, as a
-- byproduct, fixes a pre-existing gap: repositories.full_name had no supporting index at all since
-- Phase 7, so resolveProjectId()'s single-column full_name lookup has always been a full table
-- scan.
CREATE INDEX idx_repositories_full_name_provider ON repositories(full_name, provider);

-- github_links -> scm_links: the table already only ever recorded provider-neutral columns
-- (repository_id, the project link, linked_at) plus two GitHub-App-specific nullable columns
-- (installation_id/app_id, which have no GitLab/Gitea equivalent and are left exactly as-is -- a
-- future GitLab/Gitea deployment simply never populates them). No new column is added here: which
-- provider a link's repository uses is already knowable via repositories.provider above; a second,
-- redundant provider column on this table would risk drifting out of sync with the repositories
-- row it points to via repository_id.
ALTER TABLE github_links RENAME TO scm_links;

-- SQLite does not rename an index when its underlying table is renamed -- recreate it under the
-- new table's name rather than leaving a stale idx_github_links_* name pointing at scm_links.
DROP INDEX idx_github_links_project_id;
CREATE INDEX idx_scm_links_project_id ON scm_links(project_id);
