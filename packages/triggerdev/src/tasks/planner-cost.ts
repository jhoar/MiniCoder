/**
 * Cost/prompt-template-version tracking for the Planner role's `generatePlanSections()`/
 * `generateFeatureBacklog()` calls (`generate-implementation-plan.ts`/`generate-feature-backlog.ts`),
 * mirroring `run-coder.ts`'s `computeCostUsd()`/`resolvePromptTemplateVersion()` shape exactly.
 *
 * Given its own `PLANNER_PRICE_PER_1K_*`/`PLANNER_PROMPT_TEMPLATE_VERSION` env vars rather than
 * reusing Coder's `CODE_GEN_PRICE_PER_1K_*`/`CODER_PROMPT_TEMPLATE_VERSION` — the same "own price
 * pair even when defaulting to the same CODE_GEN_* endpoint" precedent `run-design-doc.ts`
 * already established for the Documentation role, since the two roles can reasonably run
 * against differently-priced models even when both default to the same endpoint.
 */

// Defaults approximate gpt-4o-mini-class pricing, same as run-coder.ts/run-design-doc.ts's
// defaults — override via env for the configured provider/model.
const DEFAULT_PRICE_PER_1K_INPUT_TOKENS = 0.00015;
const DEFAULT_PRICE_PER_1K_OUTPUT_TOKENS = 0.0006;

const PLANNER_PROMPT_TEMPLATE_VERSION = 'planner-v1';

// Same blank-value-falls-back-to-default treatment run-coder.ts's resolvePromptTemplateVersion()
// established: a blank override must not silently degrade run provenance to an empty string.
export function resolvePlannerPromptTemplateVersion(): string {
  const raw = process.env['PLANNER_PROMPT_TEMPLATE_VERSION'];
  if (raw === undefined) return PLANNER_PROMPT_TEMPLATE_VERSION;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : PLANNER_PROMPT_TEMPLATE_VERSION;
}

// Same malformed/negative/non-finite/blank guard run-coder.ts's parsePriceEnvVar() established —
// a bad pricing env var must never silently poison a persisted cost_records row.
function parsePriceEnvVar(envVarName: string, fallback: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`planner: ${envVarName} is set but blank; falling back to ${fallback}`);
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // eslint-disable-next-line no-console
    console.error(
      `planner: ${envVarName}="${raw}" is not a finite, non-negative number; falling back to ${fallback}`,
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
