/**
 * `POST /commands/{validate,reconcile,doctor,export-diagnostics}` — thin wrappers over the shared
 * read-models in `read-models/diagnostics.ts` (docs/01 §9's diagnostics-action list). `state
 * repair --apply` is deliberately NOT exposed here — see the module doc comment on
 * `read-models/diagnostics.ts`.
 *
 * None of these dispatch through `TransactionalCommandExecutor`, so none of them get `assertRole`
 * for free — each route calls `requireRole()` explicitly (`operator` minimum, per docs/00 §4.4's
 * capability list, which names `reconcile` as an operator action; `validate`/`doctor`/
 * `export-diagnostics` are held to the same floor for consistency, since `export-diagnostics` in
 * particular can surface workflow-event payload contents a `viewer` key should not be able to
 * pull). Without this, a read-only `viewer` key could otherwise call `reconcile`, which mutates
 * `workflow_locks` and can mark `outbox_events`/`inbox_events` rows `failed` globally.
 *
 * `reconcile` is the one route here with a real side effect (the other three are pure reads), so
 * it alone requires an `Idempotency-Key` header and uses the same claim-first idempotency as
 * `merge-if-ready` (`route-idempotency.ts`) — a retried/duplicated `reconcile` call must not
 * blindly re-run the mutation (or race a concurrent identical call) just because it's cheap to
 * re-read.
 */
import type { FastifyInstance } from 'fastify';
import { UserRole, type DbClient } from '@minicoder/core';
import {
  validateFeatureRunStates,
  runDoctorChecks,
  reconcileState,
  exportDiagnostics,
} from '../read-models/diagnostics.js';
import { requireRole } from '../auth/require-role.js';
import { MissingIdempotencyKeyError, RequestInProgressError } from '../errors.js';
import {
  claimRouteIdempotencyKey,
  fulfillRouteIdempotencyKey,
  releaseRouteIdempotencyKey,
} from '../route-idempotency.js';

const RECONCILE_IDEMPOTENCY_SCOPE = 'reconcile-route';
const RECONCILE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface DiagnosticsRouteDeps {
  db: DbClient;
}

export function registerDiagnosticsRoutes(app: FastifyInstance, deps: DiagnosticsRouteDeps): void {
  app.post<{ Body: { projectId?: string } }>('/commands/validate', async (request, reply) => {
    requireRole(request, UserRole.OPERATOR, 'validate');
    const result = await validateFeatureRunStates(deps.db, request.body?.projectId);
    return reply.code(200).send(result);
  });

  app.post<{ Body: { projectId?: string } }>('/commands/doctor', async (request, reply) => {
    requireRole(request, UserRole.OPERATOR, 'doctor');
    const result = await runDoctorChecks(deps.db, request.body?.projectId);
    return reply.code(200).send(result);
  });

  app.post<{ Body: { projectId?: string; all?: boolean } }>(
    '/commands/reconcile',
    async (request, reply) => {
      requireRole(request, UserRole.OPERATOR, 'reconcile');
      const { projectId, all } = request.body ?? {};
      if (!projectId && !all) {
        return reply.code(400).send({
          type: 'validation-error',
          title: 'Request validation failed',
          status: 400,
          detail: 'reconcile requires projectId (project-scoped) or all=true (global queues)',
        });
      }
      const idempotencyKeyHeader = request.headers['idempotency-key'];
      if (typeof idempotencyKeyHeader !== 'string' || idempotencyKeyHeader.trim().length === 0) {
        throw new MissingIdempotencyKeyError();
      }

      const claim = await claimRouteIdempotencyKey(
        deps.db,
        idempotencyKeyHeader,
        RECONCILE_IDEMPOTENCY_SCOPE,
        RECONCILE_IDEMPOTENCY_TTL_MS,
      );
      if (claim.outcome === 'fulfilled') {
        return reply.code(claim.response.status).send(claim.response.body);
      }
      if (claim.outcome === 'in-progress') {
        throw new RequestInProgressError(idempotencyKeyHeader);
      }

      try {
        const result = await reconcileState(deps.db, { projectId, all });
        await fulfillRouteIdempotencyKey(deps.db, claim.claimId, { status: 200, body: result });
        return reply.code(200).send(result);
      } catch (err) {
        await releaseRouteIdempotencyKey(deps.db, claim.claimId);
        throw err;
      }
    },
  );

  app.post<{ Body: { projectId?: string } }>(
    '/commands/export-diagnostics',
    async (request, reply) => {
      requireRole(request, UserRole.OPERATOR, 'export-diagnostics');
      const result = await exportDiagnostics(deps.db, request.body?.projectId);
      return reply.code(200).send(result);
    },
  );
}
