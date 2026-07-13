/**
 * `POST /commands/{request-coder-run,request-review,recompute-merge-gate}` — "enqueue" routes.
 * `request-coder-run`, `request-review`, and `recompute-merge-gate` are not `CommandHandler`s;
 * they are whole task orchestrations (`run-coder`/`run-review`/`run-merge-gate` in
 * `packages/triggerdev/src/task-registry.ts`'s `TASK_REGISTRY`, executed asynchronously by
 * `minicoder tasks worker`'s `TaskQueueDispatcher`, not inline in this request). These routes call
 * `TaskTriggerClient`'s `trigger*` methods (which enqueue a `task_queue` row — see
 * `default-task-trigger-client.ts`) and return `{triggerdevRunId, accepted}` — a deliberate
 * deviation from the standard command envelope, since there is no synchronous `CommandResult` to
 * report at request time (the task runs asynchronously on the Workflow Layer).
 *
 * "request fixes" (docs/01 §9) has no standalone handler or task of its own — `StartFixingCommand`
 * lives inside `run-review.ts`'s own decision chain (`changes_requested -> fixing`). Per the
 * confirmed Phase 13 scope decision, it is served by re-triggering `request-review`; no separate
 * route exists for it.
 *
 * No default task-trigger client is constructed here (mirroring the established "no default
 * PlannerAgentAdapter/ArbiterAgentAdapter, inject only" pattern for capabilities with no shipped
 * reference wiring at this layer) — a live deployment supplies a `TaskTriggerClient` at server
 * startup (see `app.ts`); omitting it fails fast with an actionable error only when one of these
 * routes is actually invoked.
 *
 * These routes do not dispatch through `TransactionalCommandExecutor`, so nothing enforces a role
 * floor on them for free — each handler calls `requireRole()` explicitly (`operator` minimum, per
 * docs/00 §4.4: operators may "request coder/review run" and "recompute merge gate"; viewers are
 * read-only). Without this a `viewer`-role API key could otherwise trigger real coder/reviewer/
 * merge-gate work.
 */
import type { FastifyInstance } from 'fastify';
import { UserRole } from '@minicoder/core';
import { RequestValidationError } from '../errors.js';
import { requireRole } from '../auth/require-role.js';

export interface TriggeredRun {
  triggerdevRunId: string;
}

export interface TaskTriggerClient {
  triggerRunCoder(payload: {
    projectId: string;
    featureRunId: string;
    coderAdapterName: string;
    correlationId: string;
    idempotencyKey: string;
  }): Promise<TriggeredRun>;
  triggerRunReview(payload: {
    projectId: string;
    featureRunId: string;
    reviewerAdapterName: string;
    arbiterAdapterName?: string;
    correlationId: string;
    idempotencyKey: string;
  }): Promise<TriggeredRun>;
  triggerRunMergeGate(payload: {
    projectId: string;
    featureRunId: string;
    correlationId: string;
    idempotencyKey: string;
  }): Promise<TriggeredRun>;
  triggerRunDesignDoc(payload: {
    projectId: string;
    documentationAdapterName: string;
    correlationId: string;
    idempotencyKey: string;
  }): Promise<TriggeredRun>;
}

export function unconfiguredTaskTriggerClient(): TaskTriggerClient {
  const fail = (taskName: string): never => {
    throw new Error(
      `No TaskTriggerClient configured for the Orchestrator API — the "${taskName}" route ` +
        'requires one to be injected at server startup (see packages/api/src/app.ts). No default ' +
        'Trigger.dev SDK client is constructed automatically.',
    );
  };
  return {
    triggerRunCoder: () => fail('request-coder-run'),
    triggerRunReview: () => fail('request-review'),
    triggerRunMergeGate: () => fail('recompute-merge-gate'),
    triggerRunDesignDoc: () => fail('request-design-doc'),
  };
}

export interface TaskTriggerRouteDeps {
  taskTriggerClient: TaskTriggerClient;
}

function readIdempotencyKey(header: unknown): string {
  if (typeof header !== 'string' || header.trim().length === 0) {
    throw new RequestValidationError(
      'Idempotency-Key header is required',
      'missing-idempotency-key',
    );
  }
  return header;
}

export function registerTaskTriggerRoutes(app: FastifyInstance, deps: TaskTriggerRouteDeps): void {
  app.post<{
    Body: { projectId?: string; featureRunId?: string; coderAdapterName?: string };
  }>('/commands/request-coder-run', async (request, reply) => {
    requireRole(request, UserRole.OPERATOR, 'request-coder-run');
    const { projectId, featureRunId, coderAdapterName } = request.body ?? {};
    if (!projectId || !featureRunId || !coderAdapterName) {
      throw new RequestValidationError(
        'projectId, featureRunId, and coderAdapterName are required',
      );
    }
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const run = await deps.taskTriggerClient.triggerRunCoder({
      projectId,
      featureRunId,
      coderAdapterName,
      correlationId: request.actor!.correlationId,
      idempotencyKey,
    });
    return reply.code(202).send({ triggerdevRunId: run.triggerdevRunId, accepted: true });
  });

  app.post<{
    Body: {
      projectId?: string;
      featureRunId?: string;
      reviewerAdapterName?: string;
      arbiterAdapterName?: string;
    };
  }>('/commands/request-review', async (request, reply) => {
    requireRole(request, UserRole.OPERATOR, 'request-review');
    const { projectId, featureRunId, reviewerAdapterName, arbiterAdapterName } = request.body ?? {};
    if (!projectId || !featureRunId || !reviewerAdapterName) {
      throw new RequestValidationError(
        'projectId, featureRunId, and reviewerAdapterName are required',
      );
    }
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const run = await deps.taskTriggerClient.triggerRunReview({
      projectId,
      featureRunId,
      reviewerAdapterName,
      arbiterAdapterName,
      correlationId: request.actor!.correlationId,
      idempotencyKey,
    });
    return reply.code(202).send({ triggerdevRunId: run.triggerdevRunId, accepted: true });
  });

  // Also serves docs/01 §9's "request fixes" — see module doc comment above.
  app.post<{ Body: { projectId?: string; featureRunId?: string; reviewerAdapterName?: string } }>(
    '/commands/request-fixes',
    async (request, reply) => {
      requireRole(request, UserRole.OPERATOR, 'request-fixes');
      const { projectId, featureRunId, reviewerAdapterName } = request.body ?? {};
      if (!projectId || !featureRunId || !reviewerAdapterName) {
        throw new RequestValidationError(
          'projectId, featureRunId, and reviewerAdapterName are required',
        );
      }
      const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
      const run = await deps.taskTriggerClient.triggerRunReview({
        projectId,
        featureRunId,
        reviewerAdapterName,
        correlationId: request.actor!.correlationId,
        idempotencyKey,
      });
      return reply.code(202).send({ triggerdevRunId: run.triggerdevRunId, accepted: true });
    },
  );

  app.post<{ Body: { projectId?: string; featureRunId?: string } }>(
    '/commands/recompute-merge-gate',
    async (request, reply) => {
      requireRole(request, UserRole.OPERATOR, 'recompute-merge-gate');
      const { projectId, featureRunId } = request.body ?? {};
      if (!projectId || !featureRunId) {
        throw new RequestValidationError('projectId and featureRunId are required');
      }
      const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
      const run = await deps.taskTriggerClient.triggerRunMergeGate({
        projectId,
        featureRunId,
        correlationId: request.actor!.correlationId,
        idempotencyKey,
      });
      return reply.code(202).send({ triggerdevRunId: run.triggerdevRunId, accepted: true });
    },
  );

  // Phase 17: enqueues `run-design-doc` (drafts sections via DocumentationAgentAdapter, exports
  // final-design-document.md, records the document ready) — same "enqueue route" shape as the
  // three routes above, since this is also a whole Trigger.dev task orchestration, not a single
  // synchronous command.
  app.post<{ Body: { projectId?: string; documentationAdapterName?: string } }>(
    '/commands/request-design-doc',
    async (request, reply) => {
      requireRole(request, UserRole.OPERATOR, 'request-design-doc');
      const { projectId, documentationAdapterName } = request.body ?? {};
      if (!projectId || !documentationAdapterName) {
        throw new RequestValidationError('projectId and documentationAdapterName are required');
      }
      const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
      const run = await deps.taskTriggerClient.triggerRunDesignDoc({
        projectId,
        documentationAdapterName,
        correlationId: request.actor!.correlationId,
        idempotencyKey,
      });
      return reply.code(202).send({ triggerdevRunId: run.triggerdevRunId, accepted: true });
    },
  );
}
