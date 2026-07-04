import type { DbClient } from '../persistence/types.js';
import type { BudgetScope } from '../domain/states.js';

export type BudgetEvaluationStatus = 'ok' | 'soft_breach' | 'hard_breach';

export interface BudgetPolicyRow {
  id: string;
  project_id: string;
  scope: string;
  feature_request_id: string | null;
  currency: string;
  soft_limit: number | string | null;
  hard_limit: number | string | null;
  window_days: number | null;
  is_active: number | boolean;
  updated_at: string;
}

export interface BudgetEvaluation {
  status: BudgetEvaluationStatus;
  policy: BudgetPolicyRow;
  totalSpend: number;
}

export interface EvaluateBudgetParams {
  projectId: string;
  featureRequestId?: string;
  scope: BudgetScope;
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Phase 8's minimal Cost Manager: retrospective threshold evaluation only (docs/01 §5.11 —
 * forecasting and dashboards are Phase 16). Sums cost_records live rather than maintaining a
 * denormalized running-total column, since Phase 8 data volumes don't warrant a second source
 * of truth to keep consistent; a materialized rollup can be added in Phase 16 without changing
 * this function's contract.
 *
 * Returns null when no active budget policy exists for the requested scope (nothing to
 * enforce). Hard limit is checked before soft limit, so a breach of both reports hard_breach.
 *
 * Nothing prevents more than one active budget_policies row from matching the same
 * (project, scope, feature) tuple (no uniqueness constraint, no application-level guard on
 * insert) — the ORDER BY below picks the most recently updated active row deterministically,
 * the same "most recent wins" tiebreaker convention AdapterRegistry.getConfiguration() already
 * uses for an analogous ambiguity, rather than relying on unspecified SQL result ordering.
 */
export async function evaluateBudget(
  db: DbClient,
  params: EvaluateBudgetParams,
): Promise<BudgetEvaluation | null> {
  const { projectId, featureRequestId, scope } = params;

  const policyRows = await db.query<BudgetPolicyRow>(
    `SELECT id, project_id, scope, feature_request_id, currency, soft_limit, hard_limit, window_days, is_active, updated_at
     FROM budget_policies
     WHERE project_id = ? AND scope = ?
       AND (feature_request_id = ? OR (feature_request_id IS NULL AND ? IS NULL))
     ORDER BY updated_at DESC, id DESC`,
    [projectId, scope, featureRequestId ?? null, featureRequestId ?? null],
  );
  const policy = policyRows.find((row) => Boolean(row.is_active));
  if (!policy) return null;

  const spendParams: unknown[] = [projectId, scope];
  let spendQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM cost_records WHERE project_id = ? AND scope = ?`;
  if (featureRequestId !== undefined) {
    spendQuery += ` AND feature_request_id = ?`;
    spendParams.push(featureRequestId);
  }
  if (policy.window_days !== null) {
    const cutoff = new Date(Date.now() - policy.window_days * 24 * 60 * 60 * 1000).toISOString();
    spendQuery += ` AND recorded_at >= ?`;
    spendParams.push(cutoff);
  }
  const spendRows = await db.query<{ total: number | string }>(spendQuery, spendParams);
  const totalSpend = Number(spendRows[0]?.total ?? 0);

  const hardLimit = toNumber(policy.hard_limit);
  const softLimit = toNumber(policy.soft_limit);

  let status: BudgetEvaluationStatus = 'ok';
  if (hardLimit !== null && totalSpend >= hardLimit) {
    status = 'hard_breach';
  } else if (softLimit !== null && totalSpend >= softLimit) {
    status = 'soft_breach';
  }

  return { status, policy, totalSpend };
}
