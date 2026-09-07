/**
 * Trigger.dev replacement: enqueues a `task_queue` row instead of calling
 * `@trigger.dev/sdk/v3`'s `tasks.trigger()`. `minicoder tasks worker` (backed by
 * `TaskQueueDispatcher`) polls this table and executes the matching `runImpl`.
 *
 * `INSERT ... ON CONFLICT (project_id, task_id, idempotency_key) DO NOTHING`, falling back to a
 * `SELECT` on conflict, is the same claim-first idempotency idiom already used by
 * `packages/api/src/route-idempotency.ts`'s `claimRouteIdempotencyKey()` — a repeated call with
 * the same `Idempotency-Key` for the SAME task and project returns the same `triggerdevRunId`
 * without enqueuing a duplicate row, replacing the dedup Trigger.dev previously provided
 * server-side. The conflict target is scoped to `(project_id, task_id, idempotency_key)`, not
 * `idempotency_key` alone (PR #75 review fix, MEDIUM-1: task_id; round-2 review fix, HIGH-2:
 * project_id) — a bare global-uniqueness constraint meant reusing the same key for a DIFFERENT
 * task, or the same task from a DIFFERENT project, silently returned the unrelated old row's id
 * and skipped enqueuing the new task entirely.
 *
 * `triggerdevRunId` is kept as the field name on `TriggeredRun` (unchanged from the Trigger.dev
 * implementation this replaces): it is a public response field on five routes
 * (`packages/api/src/commands/task-trigger-routes.ts`), documented in the OpenAPI spec, and
 * consumed by both the Text UI and Web UI API clients. It never literally meant "a Trigger.dev SDK
 * run id" to any consumer — only "an opaque identifier for this async run" — so retaining the name
 * avoids a purely cosmetic breaking change to a real public contract. It is now the `task_queue`
 * row's own `id`.
 */
import { generateId } from '@minicoder/core';
import { createDbClientFromEnv } from '@minicoder/triggerdev';
import type { TaskId } from '@minicoder/triggerdev';
import type { TaskTriggerClient, TriggeredRun } from './commands/task-trigger-routes.js';

async function enqueueTask(
  taskId: TaskId,
  payload: Record<string, unknown> & { projectId: string },
  idempotencyKey: string,
): Promise<TriggeredRun> {
  const db = await createDbClientFromEnv();
  try {
    const id = generateId();
    const now = new Date().toISOString();
    const inserted = await db.executeAffected(
      `INSERT INTO task_queue
         (id, task_id, payload, idempotency_key, status, attempts, project_id, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, 1, ?, ?)
       ON CONFLICT (project_id, task_id, idempotency_key) DO NOTHING`,
      [id, taskId, JSON.stringify(payload), idempotencyKey, payload.projectId, now, now],
    );
    if (inserted === 1) {
      return { triggerdevRunId: id };
    }
    const rows = await db.query<{ id: string }>(
      `SELECT id FROM task_queue WHERE project_id = ? AND task_id = ? AND idempotency_key = ?`,
      [payload.projectId, taskId, idempotencyKey],
    );
    return { triggerdevRunId: rows[0]!.id };
  } finally {
    await db.close();
  }
}

/** Constructs a `TaskTriggerClient` backed by the local `task_queue` table. */
export function resolveDefaultTaskTriggerClient(): TaskTriggerClient {
  return {
    triggerReadinessAssessment: (payload) =>
      enqueueTask('planning-readiness-assessment', payload, payload.idempotencyKey),
    triggerRunCoder: (payload) => enqueueTask('run-coder', payload, payload.idempotencyKey),
    triggerRunReview: (payload) => enqueueTask('run-review', payload, payload.idempotencyKey),
    triggerRunMergeGate: (payload) =>
      enqueueTask('run-merge-gate', payload, payload.idempotencyKey),
    triggerRunDesignDoc: (payload) =>
      enqueueTask('run-design-doc', payload, payload.idempotencyKey),
    triggerPlanGeneration: (payload) =>
      enqueueTask('generate-implementation-plan', payload, payload.idempotencyKey),
    triggerBacklogGeneration: (payload) =>
      enqueueTask('generate-feature-backlog', payload, payload.idempotencyKey),
    triggerStartNextFeature: (payload) =>
      enqueueTask('start-next-feature', payload, payload.idempotencyKey),
    triggerGithubReconciliation: (payload) =>
      enqueueTask('github-reconciliation', payload, payload.idempotencyKey),
  };
}
