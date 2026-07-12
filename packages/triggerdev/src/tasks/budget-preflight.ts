import {
  forecastBudget,
  applyBudgetDecision,
  type BudgetEvaluation,
  type BudgetScope,
  type DbClient,
} from '@minicoder/core';
import { systemActor } from './actor.js';

/**
 * Phase 16 prospective pre-flight budget check (docs/01 §5.11 "Forecast before run" /
 * per-AgentRun pre-flight cap), shared by `run-coder.ts` and `run-review.ts`. Deliberately
 * additive/opt-in: when `estimatedCostUsd` is not configured (the env var this call site's caller
 * reads is unset/blank), this always returns `{ proceed: true }` with zero extra DB work, so
 * every existing test/deployment that hasn't opted in sees no behavior change.
 *
 * This is a *prospective* check that runs BEFORE the (possibly expensive) adapter/LLM
 * invocation — it does not replace or weaken the existing *retrospective* post-hoc
 * `evaluateBudget()`/`applyBudgetDecision()` check that already runs after a run's real cost is
 * recorded in `cost_records` (that check has no caller wired yet in this codebase as of Phase 16
 * — see the Phase 16 CLAUDE.md section for the honest status of that gap). Only a forecasted
 * *hard* breach skips the call; a forecasted soft breach still proceeds (soft breaches are an
 * approval-waiting signal, not a hard stop, matching `evaluateBudget()`'s own precedence).
 *
 * On a forecasted hard breach, this reuses the exact same `RecordBudgetExceededCommand` plumbing
 * the retrospective path already uses via `applyBudgetDecision()` — no new command, no new
 * matrix row. `applyBudgetDecision()` expects a `BudgetEvaluation` (`{status, policy,
 * totalSpend}`); a `BudgetForecast`'s `projectedSpend` is passed as `totalSpend` so the recorded
 * breach reflects the projected total that triggered the skip, not the (still-under-limit)
 * current live spend.
 */
export interface BudgetPreflightParams {
  projectId: string;
  featureRequestId: string;
  scope: BudgetScope;
  correlationId: string;
  /** Parsed from the caller's own env var; `undefined` means "forecasting not configured" —
   * always proceeds. */
  estimatedCostUsd: number | undefined;
  /** Phase 16 (post-merge PR review fix, MEDIUM-2): the feature run this pre-flight check is
   * gating, attached to a recorded hard-breach `workflow_events` row so
   * `GET /feature-runs/:id/timeline` can show why that feature run's adapter call was skipped. */
  featureRunId: string;
}

export type BudgetPreflightResult =
  | { proceed: true }
  | { proceed: false; outcome: 'hard_breach'; projectedSpend: number };

// Parses the optional pre-flight-forecast estimate env var, mirroring run-coder.ts's
// parsePriceEnvVar blank/non-finite/negative rejection contract — but the "not configured"
// fallback here is `undefined` (forecasting is skipped entirely), not a numeric default, since
// there is no sensible default cost estimate for a not-yet-run LLM call. Shared by run-coder.ts
// (`CODE_GEN_ESTIMATED_COST_USD`) and run-review.ts (`REVIEW_ESTIMATED_COST_USD`).
export function resolveEstimatedCostUsd(envVarName: string): number | undefined {
  const raw = process.env[envVarName];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // eslint-disable-next-line no-console
    console.error(`${envVarName}="${raw}" is not a finite, non-negative number; ignoring`);
    return undefined;
  }
  return parsed;
}

export async function budgetPreflightCheck(
  db: DbClient,
  params: BudgetPreflightParams,
): Promise<BudgetPreflightResult> {
  const { projectId, featureRequestId, scope, correlationId, estimatedCostUsd, featureRunId } =
    params;
  if (estimatedCostUsd === undefined) return { proceed: true };

  const forecast = await forecastBudget(db, {
    projectId,
    featureRequestId,
    scope,
    estimatedCostUsd,
  });
  if (!forecast || forecast.status !== 'hard_breach') {
    return { proceed: true };
  }

  const workflowStateRows = await db.query<{ version: number }>(
    `SELECT version FROM workflow_states WHERE project_id = ?`,
    [projectId],
  );
  const workflowState = workflowStateRows[0];
  if (!workflowState) {
    // A forecasted hard breach must never be waved through just because there is no
    // workflow_states row to record the automation-pause transition against — the whole point of
    // this check is to stop the (possibly expensive) adapter call, and that decision does not
    // depend on whether the pause can also be durably recorded. Fail closed: block the call, but
    // skip only the applyBudgetDecision() write (there is nothing to CAS against) and log so an
    // operator can see the recording gap.
    // eslint-disable-next-line no-console
    console.error(
      `budgetPreflightCheck: forecasted hard breach for project ${projectId} but no workflow_states row exists; blocking the call without recording the breach`,
    );
    return { proceed: false, outcome: 'hard_breach', projectedSpend: forecast.projectedSpend };
  }

  const evaluation: BudgetEvaluation = {
    status: 'hard_breach',
    policy: forecast.policy,
    totalSpend: forecast.projectedSpend,
  };
  await applyBudgetDecision(db, evaluation, {
    projectId,
    expectedVersion: workflowState.version,
    actor: systemActor(correlationId),
    correlationId,
    featureRunId,
  });

  return { proceed: false, outcome: 'hard_breach', projectedSpend: forecast.projectedSpend };
}
