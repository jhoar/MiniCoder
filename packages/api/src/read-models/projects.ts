/**
 * Read models for the "projects", "repositories", and "GitHub links" groups
 * (docs/01-system-specification.md §9).
 */
import type { DbClient } from '@minicoder/core';
import { listByCreatedAt, type CursorPage, type ListParams } from '../pagination.js';
import { getByIdOrThrow } from './helpers.js';

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  state: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listProjects(db: DbClient, params: ListParams): Promise<CursorPage<ProjectRow>> {
  return listByCreatedAt<ProjectRow>(
    db,
    { table: 'projects', columns: 'id, name, description, state, version, created_at, updated_at' },
    params,
  );
}

export function getProject(db: DbClient, id: string): Promise<ProjectRow> {
  return getByIdOrThrow<ProjectRow>(
    db,
    'projects',
    'id, name, description, state, version, created_at, updated_at',
    id,
    'project',
  );
}

export interface RepositoryRow {
  id: string;
  project_id: string;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listRepositories(
  db: DbClient,
  projectId: string | undefined,
  params: ListParams,
): Promise<CursorPage<RepositoryRow>> {
  return listByCreatedAt<RepositoryRow>(
    db,
    {
      table: 'repositories',
      columns:
        'id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at',
      where: projectId ? 'project_id = ?' : undefined,
      params: projectId ? [projectId] : [],
    },
    params,
  );
}

/**
 * Reads the `scm_links` table (renamed from `github_links` by docs/06 §Phase 18 Stage 2 — the
 * table itself is provider-neutral, storing only a project<->repository link plus two
 * GitHub-App-specific nullable columns). `GithubLinkRow`/`listGithubLinks`, and the `/github-links`
 * route that calls it, keep their GitHub-branded names: GitHub is still the only provider a link
 * can actually be established for today, so renaming this public surface now would be a breaking
 * API change with no functional benefit — deferred to whichever later stage first gives an
 * operator a way to link a non-GitHub repository.
 */
export interface GithubLinkRow {
  id: string;
  project_id: string;
  repository_id: string | null;
  installation_id: string | null;
  app_id: string | null;
  linked_at: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listGithubLinks(
  db: DbClient,
  projectId: string | undefined,
  params: ListParams,
): Promise<CursorPage<GithubLinkRow>> {
  return listByCreatedAt<GithubLinkRow>(
    db,
    {
      table: 'scm_links',
      columns:
        'id, project_id, repository_id, installation_id, app_id, linked_at, version, created_at, updated_at',
      where: projectId ? 'project_id = ?' : undefined,
      params: projectId ? [projectId] : [],
    },
    params,
  );
}
