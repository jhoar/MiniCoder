import type { TxClient } from '../persistence/types.js';
import type { BudgetScope } from '../domain/states.js';
import { type BudgetPolicyRow, type BudgetEvaluationStatus } from './budget-evaluator.js';

export interface ForecastBudgetParams {
  projectId: string;
  featureRequestId?: string;
  scope: BudgetScope;
  /** Caller-supplied estimate (USD) of the cost the not-yet-started run is expected to incur. */
  estimatedCostUsd: number;
}

export interface BudgetForecast {
  /** `ok` | `soft_breach` | `hard_breach` against the *projected* total (current live spend +
   * `estimatedCostUsd`), using the identical hard-before-soft precedence
   * `evaluateBudget()` uses for the retrospective check. */
  status: BudgetEvaluationStatus;
  policy: BudgetPolicyRow;
  /** Live spend at forecast time (same query shape as `evaluateBudget()`), before the estimate
   * is added. */
  currentSpend: number;
  /** The caller-supplied estimate this forecast was computed against. */
  estimatedCostUsd: number;
  /** `currentSpend + estimatedCostUsd`. */
  projectedSpend: number;
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Phase 16's prospective counterpart to `evaluateBudget()` (docs/01 §5.11's "Forecast before
 * run" / per-AgentRun pre-flight cap). Deliberately does NOT replace or weaken the retrospective,
 * post-hoc `evaluateBudget()` check — that remains the source of truth once a run's real cost is
 * recorded in `cost_records`. This function only answers "if a run costing roughly
 * `estimatedCostUsd` were to complete right now, would the resulting total breach the policy?" —
 * a caller (e.g. `run-coder.ts`/`run-review.ts`) can use that answer to skip an expensive LLM
 * call before it happens, rather than only detecting the breach after paying for it.
 *
 * Reuses the exact same active-policy lookup and live `SUM(cost_records.amount)` query shape
 * `evaluateBudget()` already uses (same `window_days`/hard-before-soft precedence, same
 * "most recent wins" tiebreaker for an ambiguous multi-policy match) — this is a pure evaluation
 * function, mirroring `evaluateBudget()`'s "pure evaluation, caller decides what to do"
 * separation from `applyBudgetDecision()`. It dispatches no command and writes no row.
 *
 * Returns `null` when no active budget policy exists for the requested scope (nothing to
 * forecast against) — same contract as `evaluateBudget()`.
 *
 * Takes a `TxClient` (not `DbClient`) for the same reason `evaluateBudget()` does: it only ever
 * reads via `.query()`, so it can participate in a caller's already-open transaction.
 */
export async function forecastBudget(
  db: TxClient,
  params: ForecastBudgetParams,
): Promise<BudgetForecast | null> {
  const { projectId, featureRequestId, scope, estimatedCostUsd } = params;

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
  const currentSpend = Number(spendRows[0]?.total ?? 0);
  const projectedSpend = currentSpend + estimatedCostUsd;

  const hardLimit = toNumber(policy.hard_limit);
  const softLimit = toNumber(policy.soft_limit);

  let status: BudgetEvaluationStatus = 'ok';
  if (hardLimit !== null && projectedSpend >= hardLimit) {
    status = 'hard_breach';
  } else if (softLimit !== null && projectedSpend >= softLimit) {
    status = 'soft_breach';
  }

  return { status, policy, currentSpend, estimatedCostUsd, projectedSpend };
}
