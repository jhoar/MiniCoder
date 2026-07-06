/**
 * Read models for "features", "active feature", and "pull requests" (docs/01 §9).
 */
import type { DbClient } from '@minicoder/core';
import { listByCreatedAt, type CursorPage, type ListParams } from '../pagination.js';
import { getByIdOrThrow, getByIdOrNull } from './helpers.js';
import { NotFoundError } from '../errors.js';

export interface FeatureRequestRow {
  id: string;
  plan_id: string;
  project_id: string;
  fr_id: string;
  title: string;
  description: string;
  kind: string;
  executable: boolean;
  state: string;
  priority: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listFeatureRequests(
  db: DbClient,
  projectId: string,
  params: ListParams,
): Promise<CursorPage<FeatureRequestRow>> {
  return listByCreatedAt<FeatureRequestRow>(
    db,
    {
      table: 'feature_requests',
      columns:
        'id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at',
      where: 'project_id = ?',
      params: [projectId],
    },
    params,
  );
}

export interface FeatureRunRow {
  id: string;
  feature_request_id: string;
  attempt_no: number;
  current_execution_state: string;
  lock_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  outcome: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export async function getFeatureRequest(
  db: DbClient,
  id: string,
): Promise<{ feature: FeatureRequestRow; runs: FeatureRunRow[] }> {
  const feature = await getByIdOrThrow<FeatureRequestRow>(
    db,
    'feature_requests',
    'id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at',
    id,
    'feature-request',
  );
  const runs = await db.query<FeatureRunRow>(
    `SELECT id, feature_request_id, attempt_no, current_execution_state, lock_id, started_at, ended_at, outcome, version, created_at, updated_at
     FROM feature_runs WHERE feature_request_id = ? ORDER BY attempt_no DESC`,
    [id],
  );
  return { feature, runs };
}

export function getFeatureRun(db: DbClient, id: string): Promise<FeatureRunRow> {
  return getByIdOrThrow<FeatureRunRow>(
    db,
    'feature_runs',
    'id, feature_request_id, attempt_no, current_execution_state, lock_id, started_at, ended_at, outcome, version, created_at, updated_at',
    id,
    'feature-run',
  );
}

interface WorkflowStateRow {
  automation_state: string;
  active_feature_run_id: string | null;
}

/** "Active feature" group — the project's current `workflow_states` pointer, resolved to a run. */
export async function getActiveFeature(
  db: DbClient,
  projectId: string,
): Promise<{ automationState: string; activeFeatureRun: FeatureRunRow | null }> {
  const rows = await db.query<WorkflowStateRow>(
    'SELECT automation_state, active_feature_run_id FROM workflow_states WHERE project_id = ?',
    [projectId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('workflow-state', projectId);
  const activeFeatureRun = row.active_feature_run_id
    ? await getByIdOrNull<FeatureRunRow>(
        db,
        'feature_runs',
        'id, feature_request_id, attempt_no, current_execution_state, lock_id, started_at, ended_at, outcome, version, created_at, updated_at',
        row.active_feature_run_id,
      )
    : null;
  return { automationState: row.automation_state, activeFeatureRun };
}

export interface PullRequestRow {
  id: string;
  feature_run_id: string;
  pr_number: number;
  branch_name: string;
  base_branch: string;
  head_sha: string | null;
  state: string;
  review_state: string;
  ci_status: string;
  mergeable: boolean | null;
  blocking_labels: unknown;
  conversations_resolved: boolean;
  merged_at: string | null;
  merge_sha: string | null;
  closed_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export function getPullRequestByFeatureRun(
  db: DbClient,
  featureRunId: string,
): Promise<PullRequestRow> {
  return getByIdOrThrowByColumn<PullRequestRow>(
    db,
    'pull_requests',
    'id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state, ci_status, mergeable, blocking_labels, conversations_resolved, merged_at, merge_sha, closed_at, version, created_at, updated_at',
    'feature_run_id',
    featureRunId,
    'pull-request',
  );
}

export function listPullRequests(
  db: DbClient,
  projectId: string,
  params: ListParams,
): Promise<CursorPage<PullRequestRow>> {
  return listByCreatedAt<PullRequestRow>(
    db,
    {
      table: 'pull_requests',
      columns:
        'id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state, ci_status, mergeable, blocking_labels, conversations_resolved, merged_at, merge_sha, closed_at, version, created_at, updated_at',
      where:
        'feature_run_id IN (SELECT fr.id FROM feature_runs fr JOIN feature_requests freq ON fr.feature_request_id = freq.id WHERE freq.project_id = ?)',
      params: [projectId],
    },
    params,
  );
}

export interface HumanRequiredItemRow {
  feature_run_id: string;
  feature_request_id: string;
  fr_id: string;
  title: string;
  current_execution_state: string;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * "Human-required items" (docs/05 §3) — `feature_runs` parked at `human_required`, joined to
 * their `feature_requests` for display. `feature_requests.state` is a static label set once at
 * backlog generation (CLAUDE.md) and never reaches `human_required` itself, so this must read the
 * live `feature_runs.current_execution_state`, not a `--state` filter on `/features`.
 *
 * Kept as a plain single-table `listByCreatedAt` over `feature_runs` (project-scoped via an `IN`
 * subquery, the same shape `listPullRequests` above already uses) plus a second batch lookup for
 * `fr_id`/`title`, rather than a joined FROM — `listByCreatedAt`'s cursor WHERE/ORDER BY reference
 * bare `created_at`/`id`, which would be ambiguous across two joined tables on both SQLite and
 * PostgreSQL.
 */
export async function listHumanRequiredItems(
  db: DbClient,
  projectId: string,
  params: ListParams,
): Promise<CursorPage<HumanRequiredItemRow>> {
  const page = await listByCreatedAt<{
    id: string;
    feature_request_id: string;
    current_execution_state: string;
    version: number;
    created_at: string;
    updated_at: string;
  }>(
    db,
    {
      table: 'feature_runs',
      columns: 'id, feature_request_id, current_execution_state, version, created_at, updated_at',
      where: `current_execution_state = 'human_required' AND feature_request_id IN (SELECT id FROM feature_requests WHERE project_id = ?)`,
      params: [projectId],
    },
    params,
  );
  if (page.items.length === 0) return { items: [], nextCursor: page.nextCursor };

  const featureRequestIds = [...new Set(page.items.map((run) => run.feature_request_id))];
  const placeholders = featureRequestIds.map(() => '?').join(', ');
  const featureRequests = await db.query<{ id: string; fr_id: string; title: string }>(
    `SELECT id, fr_id, title FROM feature_requests WHERE id IN (${placeholders})`,
    featureRequestIds,
  );
  const byId = new Map(featureRequests.map((fr) => [fr.id, fr]));
  const items = page.items.map((run) => {
    const fr = byId.get(run.feature_request_id);
    return {
      feature_run_id: run.id,
      feature_request_id: run.feature_request_id,
      fr_id: fr?.fr_id ?? '',
      title: fr?.title ?? '',
      current_execution_state: run.current_execution_state,
      version: run.version,
      created_at: run.created_at,
      updated_at: run.updated_at,
    };
  });
  return { items, nextCursor: page.nextCursor };
}

async function getByIdOrThrowByColumn<T>(
  db: DbClient,
  table: string,
  columns: string,
  column: string,
  value: string,
  resourceName: string,
): Promise<T> {
  const rows = await db.query<T>(`SELECT ${columns} FROM ${table} WHERE ${column} = ?`, [value]);
  const row = rows[0];
  if (!row) throw new NotFoundError(resourceName, value);
  return row;
}
