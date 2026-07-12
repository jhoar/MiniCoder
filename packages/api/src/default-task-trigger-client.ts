/**
 * Issue #61: `minicoder api serve` never wired a real `TaskTriggerClient`, so every real
 * deployment's `request-coder-run`/`request-review`/`request-fixes`/`recompute-merge-gate`/
 * `request-design-doc` route fail-fast against `unconfiguredTaskTriggerClient()` — these five
 * routes were fully implemented and tested against an injected mock, but non-functional in
 * production.
 *
 * This resolver constructs a real client against the Trigger.dev *runtime* API (`tasks.trigger()`
 * from `@trigger.dev/sdk/v3`, authenticated via the standard `TRIGGER_SECRET_KEY`/
 * `TRIGGER_API_URL` env vars) — deliberately **not** the Trigger.dev *management* API
 * (`list-runs`/`inspect-run`/`cancel-run`/etc., which CLAUDE.md's Orchestrator API Operational
 * Constraints section explicitly scopes out of this phase; that remains `packages/cli/src/
 * commands/trigger.ts`'s stub territory). Triggering a run by task ID and payload is a distinct,
 * much narrower capability than the management API's deploy/inspect/replay surface.
 *
 * `@trigger.dev/sdk/v3`'s `tasks.trigger(id, payload, options)` triggers a task purely by its
 * string ID — it does **not** require importing the actual `Task` object, so this module never
 * imports `packages/triggerdev/src/triggerdev-tasks.ts` (which calls `task({ id: ... })` for all
 * 19 canonical tasks at module load — a real Trigger.dev-runtime registration side effect this
 * process must not trigger). This mirrors the established "construct the real reference
 * implementation from env vars via dynamic `import()`" pattern already used for
 * `resolveDefaultGithubClientFactory`/`resolveDefaultCoderAdapterFactory`/
 * `resolveDefaultArbiterAdapterFactory` elsewhere in this codebase.
 *
 * Fails fast with an actionable error only when a route is actually invoked and
 * `TRIGGER_SECRET_KEY` is missing/blank — not at server startup, matching
 * `unconfiguredTaskTriggerClient()`'s existing "fail only when actually used" contract so a
 * deployment that never calls these five routes is unaffected by a missing Trigger.dev credential.
 */
import { requireNonBlankEnvVar } from '@minicoder/triggerdev';
import type { TaskTriggerClient, TriggeredRun } from './commands/task-trigger-routes.js';

async function triggerTask(
  taskId: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<TriggeredRun> {
  requireNonBlankEnvVar(
    'TRIGGER_SECRET_KEY',
    'minicoder api serve requires a Trigger.dev API credential to enqueue Workflow Layer tasks ' +
      "(see docs/01-system-specification.md §14 and CLAUDE.md's Trigger.dev Operational " +
      'Constraints for the self-hosted/Cloud backend setup).',
  );
  const { tasks } = await import('@trigger.dev/sdk/v3');
  // `tasks.trigger<TTask>()`'s generic signature is designed for a caller that imports the real
  // `Task` object (giving TypeScript a concrete payload/output type to infer); triggering purely
  // by string ID from a separate process — the whole point of this module — has no such object to
  // infer from. The cast reflects the SDK's own documented "trigger by string ID from your
  // backend" usage (its own `tasks.d.ts` doc comment shows exactly this call shape); the runtime
  // behavior is identical either way; only the compile-time generic inference is being worked
  // around.
  const trigger = tasks.trigger as unknown as (
    id: string,
    payload: Record<string, unknown>,
    options: { idempotencyKey: string },
  ) => Promise<{ id: string }>;
  const handle = await trigger(taskId, payload, { idempotencyKey });
  return { triggerdevRunId: handle.id };
}

/** Constructs a `TaskTriggerClient` backed by the real Trigger.dev runtime API. */
export function resolveDefaultTaskTriggerClient(): TaskTriggerClient {
  return {
    triggerRunCoder: (payload) => triggerTask('run-coder', payload, payload.idempotencyKey),
    triggerRunReview: (payload) => triggerTask('run-review', payload, payload.idempotencyKey),
    triggerRunMergeGate: (payload) =>
      triggerTask('run-merge-gate', payload, payload.idempotencyKey),
    triggerRunDesignDoc: (payload) =>
      triggerTask('run-design-doc', payload, payload.idempotencyKey),
  };
}
