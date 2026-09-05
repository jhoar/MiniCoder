import type { PlannerAgentAdapter } from '@minicoder/core';
import { requireNonBlankEnvVar } from './env.js';

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
    }),
  });
}
