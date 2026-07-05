/**
 * `POST /commands/{validate,reconcile,doctor,export-diagnostics}` — thin wrappers over the shared
 * read-models in `read-models/diagnostics.ts` (docs/01 §9's diagnostics-action list). `state
 * repair --apply` is deliberately NOT exposed here — see the module doc comment on
 * `read-models/diagnostics.ts`.
 */
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import {
  validateFeatureRunStates,
  runDoctorChecks,
  reconcileState,
  exportDiagnostics,
} from '../read-models/diagnostics.js';

export interface DiagnosticsRouteDeps {
  db: DbClient;
}

export function registerDiagnosticsRoutes(app: FastifyInstance, deps: DiagnosticsRouteDeps): void {
  app.post<{ Body: { projectId?: string } }>('/commands/validate', async (request, reply) => {
    const result = await validateFeatureRunStates(deps.db, request.body?.projectId);
    return reply.code(200).send(result);
  });

  app.post<{ Body: { projectId?: string } }>('/commands/doctor', async (request, reply) => {
    const result = await runDoctorChecks(deps.db, request.body?.projectId);
    return reply.code(200).send(result);
  });

  app.post<{ Body: { projectId?: string; all?: boolean } }>(
    '/commands/reconcile',
    async (request, reply) => {
      const { projectId, all } = request.body ?? {};
      if (!projectId && !all) {
        return reply.code(400).send({
          type: 'validation-error',
          title: 'Request validation failed',
          status: 400,
          detail: 'reconcile requires projectId (project-scoped) or all=true (global queues)',
        });
      }
      const result = await reconcileState(deps.db, { projectId, all });
      return reply.code(200).send(result);
    },
  );

  app.post<{ Body: { projectId?: string } }>(
    '/commands/export-diagnostics',
    async (request, reply) => {
      const result = await exportDiagnostics(deps.db, request.body?.projectId);
      return reply.code(200).send(result);
    },
  );
}
