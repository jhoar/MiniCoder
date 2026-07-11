/**
 * Budget reporting read model (docs/01 §5.11 — Phase 16's dashboards addition on top of Phase 8's
 * `evaluateBudget()`/`applyBudgetDecision()` budget-gate primitive). Pure aggregation over
 * `cost_records`, grouped by project/feature/scope/provider/model/role, over an optional
 * `windowDays` lookback — no new table, no denormalized rollup (same "Phase 8 data volumes don't
 * warrant a second source of truth" reasoning `evaluateBudget()`'s own doc comment already gives).
 *
 * The by-role breakdown joins `cost_records` to `agent_runs` (via `agent_run_id`) to recover
 * `role` — `cost_records` itself carries no role column. This is a plain `GROUP BY` aggregation
 * with fully-qualified/aliased output columns, not a cursor-paginated listing, so it does not hit
 * the ambiguous-bare-column-in-WHERE/ORDER-BY gotcha CLAUDE.md documents for `listHumanRequiredItems()`-
 * style joins — there is no `WHERE`/`ORDER BY` referencing an unqualified column shared by both
 * tables here.
 */
import type { DbClient } from '@minicoder/core';

export interface BudgetReportParams {
  projectId: string;
  /** Optional lookback window in days; omitted means "all recorded spend for the project." */
  windowDays?: number;
}

export interface BudgetBreakdownRow {
  key: string;
  totalAmount: number;
  recordCount: number;
}

export interface BudgetReport {
  projectId: string;
  windowDays: number | null;
  totalAmount: number;
  recordCount: number;
  byScope: BudgetBreakdownRow[];
  byFeature: BudgetBreakdownRow[];
  byProvider: BudgetBreakdownRow[];
  byModel: BudgetBreakdownRow[];
  byRole: BudgetBreakdownRow[];
}

function windowCutoff(windowDays?: number): string | null {
  if (windowDays === undefined) return null;
  return new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
}

async function groupBy(
  db: DbClient,
  column: string,
  projectId: string,
  cutoff: string | null,
  extraJoin?: string,
): Promise<BudgetBreakdownRow[]> {
  const params: unknown[] = [projectId];
  let sql = `SELECT COALESCE(${column}, '(none)') as key, COALESCE(SUM(cr.amount), 0) as totalAmount, COUNT(*) as recordCount
             FROM cost_records cr
             ${extraJoin ?? ''}
             WHERE cr.project_id = ?`;
  if (cutoff !== null) {
    sql += ` AND cr.recorded_at >= ?`;
    params.push(cutoff);
  }
  sql += ` GROUP BY ${column} ORDER BY totalAmount DESC`;
  const rows = await db.query<{ key: string; totalAmount: number | string; recordCount: number | string }>(
    sql,
    params,
  );
  return rows.map((r) => ({
    key: r.key,
    totalAmount: Number(r.totalAmount),
    recordCount: Number(r.recordCount),
  }));
}

export async function getBudgetReport(db: DbClient, params: BudgetReportParams): Promise<BudgetReport> {
  const { projectId, windowDays } = params;
  const cutoff = windowCutoff(windowDays);

  const totalParams: unknown[] = [projectId];
  let totalSql = `SELECT COALESCE(SUM(amount), 0) as totalAmount, COUNT(*) as recordCount
                  FROM cost_records WHERE project_id = ?`;
  if (cutoff !== null) {
    totalSql += ` AND recorded_at >= ?`;
    totalParams.push(cutoff);
  }
  const totalRows = await db.query<{ totalAmount: number | string; recordCount: number | string }>(
    totalSql,
    totalParams,
  );
  const totalAmount = Number(totalRows[0]?.totalAmount ?? 0);
  const recordCount = Number(totalRows[0]?.recordCount ?? 0);

  const [byScope, byFeature, byProvider, byModel, byRole] = await Promise.all([
    groupBy(db, 'cr.scope', projectId, cutoff),
    groupBy(db, 'cr.feature_request_id', projectId, cutoff),
    groupBy(db, 'cr.provider', projectId, cutoff),
    groupBy(db, 'cr.model', projectId, cutoff),
    groupBy(db, 'ar.role', projectId, cutoff, 'LEFT JOIN agent_runs ar ON ar.id = cr.agent_run_id'),
  ]);

  return {
    projectId,
    windowDays: windowDays ?? null,
    totalAmount,
    recordCount,
    byScope,
    byFeature,
    byProvider,
    byModel,
    byRole,
  };
}
