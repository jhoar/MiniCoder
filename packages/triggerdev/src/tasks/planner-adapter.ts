import type { PlannerAgentAdapter } from '@minicoder/core';
import { requireNonBlankEnvVar } from './env.js';

// HttpPlanProvider's own built-in default (30s) was sized for `run()`'s readiness-assessment call
// — a short verdict + a handful of gaps/assumptions/questions. `generatePlanSections()`/
// `generateFeatureBacklog()` (issue #32's generation methods, wired into
// generate-implementation-plan.ts/generate-feature-backlog.ts) ask the same endpoint to decompose
// an entire specification into full plan sections or a complete feature backlog in one request —
// a genuinely slower call for any real spec. Confirmed empirically in two rounds against a real
// ~1200-line specification: 30s wasn't enough for generatePlanSections() (all 3 worker retries
// timed out); a first fix raised the default to 120s, which was enough for generatePlanSections()
// but still not enough for generateFeatureBacklog() (2 more real timeouts) — that call asks for
// many structured per-feature fields (frId/title/description/priority/dependencies/acceptance
// criteria/test expectations) across every plan section, a heavier completion than plan-section
// generation. One shared `HttpPlanProvider` instance serves every PlannerAgentAdapter call (there
// is no per-method timeout on that class), so this raises the ceiling for every call including the
// much faster readiness assessment too — harmless, since a call that normally finishes in a few
// seconds is unaffected by a higher ceiling.
const DEFAULT_PLANNER_TIMEOUT_MS = 300_000;

export function resolvePlannerTimeoutMs(): number {
  const raw = process.env['PLANNER_TIMEOUT_MS'];
  if (raw === undefined) return DEFAULT_PLANNER_TIMEOUT_MS;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      `planner: PLANNER_TIMEOUT_MS is set but blank; falling back to ${DEFAULT_PLANNER_TIMEOUT_MS}`,
    );
    return DEFAULT_PLANNER_TIMEOUT_MS;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // eslint-disable-next-line no-console
    console.error(
      `planner: PLANNER_TIMEOUT_MS="${raw}" is not a finite, positive number; falling back to ${DEFAULT_PLANNER_TIMEOUT_MS}`,
    );
    return DEFAULT_PLANNER_TIMEOUT_MS;
  }
  return parsed;
}

/**
 * Constructs the real reference `GenericLLMPlannerAdapter` (issue #32) from env config. Shared by
 * every task that needs the default (non-injected) planner adapter instance —
 * `planning-readiness-assessment`, `generate-implementation-plan`, and `generate-feature-backlog`
 * — so the `CODE_GEN_*` env resolution lives in exactly one place rather than being copy-pasted
 * per task (moved verbatim out of `task-registry.ts`, which now imports this instead of defining
 * it inline).
 */
export async function resolveDefaultPlannerAdapter(): Promise<PlannerAgentAdapter> {
  const codeGenBaseUrl = requireNonBlankEnvVar(
    'CODE_GEN_BASE_URL',
    'planning-readiness-assessment requires an OpenAI-compatible endpoint — see ' +
      'docs/07-security-and-secrets.md §3.',
  );
  const codeGenApiKey = requireNonBlankEnvVar(
    'CODE_GEN_API_KEY',
    'planning-readiness-assessment requires an OpenAI-compatible endpoint — see ' +
      'docs/07-security-and-secrets.md §3.',
  );
  const codeGenModel = requireNonBlankEnvVar(
    'CODE_GEN_MODEL',
    'planning-readiness-assessment requires an OpenAI-compatible endpoint — see ' +
      'docs/07-security-and-secrets.md §3.',
  );
  const { GenericLLMPlannerAdapter, HttpPlanProvider } =
    await import('@minicoder/adapters-planner');
  return new GenericLLMPlannerAdapter({
    planProvider: new HttpPlanProvider({
      baseUrl: codeGenBaseUrl,
      apiKey: codeGenApiKey,
      model: codeGenModel,
      timeoutMs: resolvePlannerTimeoutMs(),
    }),
  });
}
