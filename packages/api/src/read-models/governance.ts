/**
 * Read models for "review findings", "disagreements", "policy decisions", "costs", and "budgets"
 * (docs/01 §9).
 */
import type { DbClient } from '@minicoder/core';
import { listByCreatedAt, type CursorPage, type ListParams } from '../pagination.js';

export interface ReviewFindingRow {
  id: string;
  feature_run_id: string;
  reviewer_run_id: string | null;
  review_cycle: number;
  severity: string;
  category: string | null;
  description: string;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  resolved: boolean;
  resolved_by_run_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const REVIEW_FINDING_COLUMNS =
  'id, feature_run_id, reviewer_run_id, review_cycle, severity, category, description, file_path, line_start, line_end, resolved, resolved_by_run_id, version, created_at, updated_at';

export function listReviewFindings(
  db: DbClient,
  featureRunId: string,
  params: ListParams,
): Promise<CursorPage<ReviewFindingRow>> {
  return listByCreatedAt<ReviewFindingRow>(
    db,
    {
      table: 'review_findings',
      columns: REVIEW_FINDING_COLUMNS,
      where: 'feature_run_id = ?',
      params: [featureRunId],
    },
    params,
  );
}

export interface DisagreementRow {
  id: string;
  feature_run_id: string;
  finding_id: string | null;
  review_cycle: number;
  state: string;
  arbiter_run_id: string | null;
  resolution: string | null;
  resolved_at: string | null;
  /** Resolved via `feature_runs.feature_request_id`, not present on `disagreement_records`
   * itself — see `listDisagreements()`'s doc comment (issue #63). */
  feature_request_id: string;
  /** Resolved via `feature_requests.project_id` (a disagreement's owning feature can belong to a
   * *different* project than whichever one is currently selected in the Web UI's `?project=`
   * param — see CLAUDE.md's Next.js Web UI Operational Constraints, MEDIUM-6). */
  project_id: string;
  version: number;
  created_at: string;
  updated_at: string;
}

const DISAGREEMENT_COLUMNS =
  'id, feature_run_id, finding_id, review_cycle, state, arbiter_run_id, resolution, resolved_at, version, created_at, updated_at';

/**
 * `disagreement_records` carries only `feature_run_id` — `/features/[id]` expects a feature
 * *request* ID, and its real project ID lives on `feature_requests`, not `feature_runs`. This
 * resolves both via two batch queries after the base list (mirroring `listHumanRequiredItems()`'s
 * two-step pattern), not a three-table JOIN inlined into `listByCreatedAt`'s query: that helper's
 * `WHERE`/`ORDER BY` reference bare `created_at`/`id`, which would be ambiguous once joined against
 * `feature_runs`/`feature_requests` (both of which also carry those column names) — the same
 * cross-dialect ambiguous-column hazard `listHumanRequiredItems()` already avoids for this reason
 * (CLAUDE.md's Ink Text UI Operational Constraints). This closes issue #63: the Web UI previously
 * resolved this same chain with one `getFeatureRun`/`getFeature` HTTP round-trip pair *per
 * disagreement row* (`packages/web/src/lib/resolve-disagreement-features.ts`, now removed) — an
 * O(n) render-time fan-out. Resolving it here instead costs a fixed 3 backend queries per page
 * (the base list plus these two batches), regardless of how many disagreement rows it returns.
 */
export async function listDisagreements(
  db: DbClient,
  filters: { featureRunId?: string; state?: string },
  params: ListParams,
): Promise<CursorPage<DisagreementRow>> {
  const clauses: string[] = [];
  const queryParams: unknown[] = [];
  if (filters.featureRunId) {
    clauses.push('feature_run_id = ?');
    queryParams.push(filters.featureRunId);
  }
  if (filters.state) {
    clauses.push('state = ?');
    queryParams.push(filters.state);
  }
  const page = await listByCreatedAt<Omit<DisagreementRow, 'feature_request_id' | 'project_id'>>(
    db,
    {
      table: 'disagreement_records',
      columns: DISAGREEMENT_COLUMNS,
      where: clauses.length > 0 ? clauses.join(' AND ') : undefined,
      params: queryParams,
    },
    params,
  );
  if (page.items.length === 0) return { items: [], nextCursor: page.nextCursor };

  const featureRunIds = [...new Set(page.items.map((d) => d.feature_run_id))];
  const runPlaceholders = featureRunIds.map(() => '?').join(', ');
  const runs = await db.query<{ id: string; feature_request_id: string }>(
    `SELECT id, feature_request_id FROM feature_runs WHERE id IN (${runPlaceholders})`,
    featureRunIds,
  );
  const featureRequestIdByRunId = new Map(runs.map((r) => [r.id, r.feature_request_id]));

  const featureRequestIds = [...new Set(runs.map((r) => r.feature_request_id))];
  const requestPlaceholders = featureRequestIds.map(() => '?').join(', ');
  const requests =
    featureRequestIds.length > 0
      ? await db.query<{ id: string; project_id: string }>(
          `SELECT id, project_id FROM feature_requests WHERE id IN (${requestPlaceholders})`,
          featureRequestIds,
        )
      : [];
  const projectIdByFeatureRequestId = new Map(requests.map((r) => [r.id, r.project_id]));

  const items = page.items.map((d) => {
    const featureRequestId = featureRequestIdByRunId.get(d.feature_run_id) ?? '';
    const projectId = projectIdByFeatureRequestId.get(featureRequestId) ?? '';
    return { ...d, feature_request_id: featureRequestId, project_id: projectId };
  });
  return { items, nextCursor: page.nextCursor };
}

export interface PolicyDecisionRow {
  id: string;
  project_id: string;
  feature_run_id: string | null;
  policy_type: string;
  decision: string;
  context: unknown;
  actor: string | null;
  decided_at: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listPolicyDecisions(
  db: DbClient,
  projectId: string,
  params: ListParams,
): Promise<CursorPage<PolicyDecisionRow>> {
  return listByCreatedAt<PolicyDecisionRow>(
    db,
    {
      table: 'policy_decisions',
      columns:
        'id, project_id, feature_run_id, policy_type, decision, context, actor, decided_at, version, created_at, updated_at',
      where: 'project_id = ?',
      params: [projectId],
    },
    params,
  );
}

export interface CostRecordRow {
  id: string;
  project_id: string;
  feature_request_id: string | null;
  feature_run_id: string | null;
  agent_run_id: string | null;
  scope: string;
  amount: number;
  currency: string;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  recorded_at: string;
  created_at: string;
}

export function listCostRecords(
  db: DbClient,
  projectId: string,
  params: ListParams,
): Promise<CursorPage<CostRecordRow>> {
  return listByCreatedAt<CostRecordRow>(
    db,
    {
      table: 'cost_records',
      columns:
        'id, project_id, feature_request_id, feature_run_id, agent_run_id, scope, amount, currency, provider, model, input_tokens, output_tokens, recorded_at, created_at',
      where: 'project_id = ?',
      params: [projectId],
    },
    params,
  );
}

export interface BudgetPolicyRow {
  id: string;
  project_id: string;
  scope: string;
  feature_request_id: string | null;
  currency: string;
  soft_limit: number | null;
  hard_limit: number | null;
  window_days: number | null;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listBudgetPolicies(
  db: DbClient,
  projectId: string,
  params: ListParams,
): Promise<CursorPage<BudgetPolicyRow>> {
  return listByCreatedAt<BudgetPolicyRow>(
    db,
    {
      table: 'budget_policies',
      columns:
        'id, project_id, scope, feature_request_id, currency, soft_limit, hard_limit, window_days, is_active, version, created_at, updated_at',
      where: 'project_id = ?',
      params: [projectId],
    },
    params,
  );
}
