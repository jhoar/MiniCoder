/**
 * Issue #61: `minicoder api serve` never wired a real `TaskTriggerClient`, so every real
 * deployment's `request-coder-run`/`request-review`/`request-fixes`/`recompute-merge-gate`/
 * `request-design-doc` route fail-fast against `unconfiguredTaskTriggerClient()` — these five
 * routes were fully implemented and tested against an injected mock, but non-functional in
 * production.
 *
 * This resolver constructs a real client against the Trigger.dev *runtime* API (`tasks.trigger()`
 * from `@trigger.dev/sdk/v3`) — deliberately **not** the Trigger.dev *management* API
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
 * `resolveDefaultArbiterAdapterFactory` elsewhere in this codebase. `taskId` is typed as
 * `@minicoder/triggerdev`'s `TaskId` (not a bare `string`) — every call site below is one of the
 * four already-canonical task IDs, so a future rename of any of them is a compile error here
 * instead of a silent runtime drift (PR #73 review fix, LOW-3).
 *
 * PR #73 review fix (MEDIUM-2): both `TRIGGER_SECRET_KEY` **and** `TRIGGER_API_URL` are required
 * and explicitly passed to `configure()` before every call — not left to the SDK's own ambient
 * env-var pickup. The SDK silently falls back to Trigger.dev Cloud's hosted API URL
 * (`https://api.trigger.dev`) when `TRIGGER_API_URL` is unset; CLAUDE.md's own "Trigger.dev
 * execution backend is a separate axis from the state store" decision names self-host
 * single-node as the *default* backend and frames Cloud as an explicit, separate security/
 * compliance choice (payloads leave the user's boundary) — silently defaulting a self-hosted
 * deployment's missing config to Cloud would violate that decision instead of failing loudly.
 * Requiring both env vars explicitly, and passing them to `configure()` by value rather than
 * relying on the SDK reading `process.env` itself, makes the actual configured target visible
 * and testable at this call site.
 *
 * Fails fast with an actionable error only when a route is actually invoked and either env var
 * is missing/blank — not at server startup, matching `unconfiguredTaskTriggerClient()`'s existing
 * "fail only when actually used" contract so a deployment that never calls these five routes is
 * unaffected by missing Trigger.dev credentials.
 */
import { requireNonBlankEnvVar } from '@minicoder/triggerdev';
import type { TaskId } from '@minicoder/triggerdev';
import type { TaskTriggerClient, TriggeredRun } from './commands/task-trigger-routes.js';

async function triggerTask(
  taskId: TaskId,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<TriggeredRun> {
  const secretKey = requireNonBlankEnvVar(
    'TRIGGER_SECRET_KEY',
    'minicoder api serve requires a Trigger.dev API credential to enqueue Workflow Layer tasks ' +
      "(see docs/01-system-specification.md §14 and CLAUDE.md's Trigger.dev Operational " +
      'Constraints for the self-hosted/Cloud backend setup).',
  );
  const apiUrl = requireNonBlankEnvVar(
    'TRIGGER_API_URL',
    'minicoder api serve requires TRIGGER_API_URL to be set explicitly (e.g. your self-hosted ' +
      'Trigger.dev webapp URL) — this is never inferred or defaulted to Trigger.dev Cloud, per ' +
      'CLAUDE.md\'s Trigger.dev Operational Constraints ("self-host single-node" is the default ' +
      "backend; Cloud is a separate, explicit choice since payloads leave the deployment's " +
      'trust boundary).',
  );
  const { tasks, configure } = await import('@trigger.dev/sdk/v3');
  configure({ baseURL: apiUrl, accessToken: secretKey });
  // `tasks.trigger<TTask>()`'s generic signature is designed for a caller that imports the real
  // `Task` object (giving TypeScript a concrete payload/output type to infer); triggering purely
  // by string ID from a separate process — the whole point of this module — has no such object to
  // infer from. The cast reflects the SDK's own documented "trigger by string ID from your
  // backend" usage (its own `tasks.d.ts` doc comment shows exactly this call shape); the runtime
  // behavior is identical either way; only the compile-time generic inference is being worked
  // around.
  const trigger = tasks.trigger as unknown as (
    id: TaskId,
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
