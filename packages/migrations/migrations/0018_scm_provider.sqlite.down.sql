DROP INDEX idx_scm_links_project_id;
ALTER TABLE scm_links RENAME TO github_links;
CREATE INDEX idx_github_links_project_id ON github_links(project_id);

DROP INDEX idx_repositories_full_name_provider;
ALTER TABLE repositories DROP COLUMN base_url;
ALTER TABLE repositories DROP COLUMN provider;
