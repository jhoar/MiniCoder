/**
 * Cost/prompt-template-version tracking for `AssessPlanningReadinessHandler`'s Planner-role
 * invocation (issue #100), mirroring `packages/triggerdev/src/tasks/run-coder.ts`'s
 * `computeCostUsd()`/`resolvePromptTemplateVersion()` shape exactly.
 *
 * This is a deliberate, small duplication of
 * `packages/triggerdev/src/tasks/planner-cost.ts` (which computes the identical
 * `PLANNER_PRICE_PER_1K_*`/`PLANNER_PROMPT_TEMPLATE_VERSION` env-derived values for
 * `generate-implementation-plan.ts`/`generate-feature-backlog.ts`), not an oversight: those two
 * tasks live in `packages/triggerdev` and call `recorder.record()` from the task process itself,
 * while `AssessPlanningReadinessHandler` is a `packages/core` command handler that builds its own
 * `recorder.record()` options inline — core must never depend on `packages/triggerdev` (the
 * dependency runs the other way), so the two implementations cannot share one module. Both read
 * the same env var names, so an operator configures pricing once regardless of which Planner call
 * site is running. Uses `EnvConfigBackend` (never bare `process.env`) per core's own
 * `no-restricted-syntax` ESLint rule, the same pattern `resolveBlockingLabelsPolicy()`
 * (`packages/core/src/merge-gate/constants.ts`) already established.
 */
import { EnvConfigBackend } from '../config/config.js';

const envConfig = new EnvConfigBackend();

// Defaults approximate gpt-4o-mini-class pricing, matching every other role's default.
const DEFAULT_PRICE_PER_1K_INPUT_TOKENS = 0.00015;
const DEFAULT_PRICE_PER_1K_OUTPUT_TOKENS = 0.0006;

const PLANNER_PROMPT_TEMPLATE_VERSION = 'planner-v1';

// Same blank-value-falls-back-to-default treatment run-coder.ts's resolvePromptTemplateVersion()
// established: a blank override must not silently degrade run provenance to an empty string.
export function resolvePlannerPromptTemplateVersion(): string {
  const raw = envConfig.get('PLANNER_PROMPT_TEMPLATE_VERSION');
  if (raw === undefined) return PLANNER_PROMPT_TEMPLATE_VERSION;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : PLANNER_PROMPT_TEMPLATE_VERSION;
}

// Same malformed/negative/non-finite/blank guard run-coder.ts's parsePriceEnvVar() established —
// a bad pricing env var must never silently poison a persisted cost_records row.
function parsePriceEnvVar(envVarName: string, fallback: number): number {
  const raw = envConfig.get(envVarName);
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`AssessPlanningReadinessHandler: ${envVarName} is set but blank; falling back to ${fallback}`);
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // eslint-disable-next-line no-console
    console.error(
      `AssessPlanningReadinessHandler: ${envVarName}="${raw}" is not a finite, non-negative number; falling back to ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

export function computePlannerCostUsd(inputTokens: number, outputTokens: number): number {
  const pricePerKInput = parsePriceEnvVar(
    'PLANNER_PRICE_PER_1K_INPUT_TOKENS',
    DEFAULT_PRICE_PER_1K_INPUT_TOKENS,
  );
  const pricePerKOutput = parsePriceEnvVar(
    'PLANNER_PRICE_PER_1K_OUTPUT_TOKENS',
    DEFAULT_PRICE_PER_1K_OUTPUT_TOKENS,
  );
  return (inputTokens / 1000) * pricePerKInput + (outputTokens / 1000) * pricePerKOutput;
}
