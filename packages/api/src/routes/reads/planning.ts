import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import {
  listSpecificationInputs,
  listPlanningReadinessAssessments,
  getPlanningReadinessAssessment,
  listClarificationSessions,
  getClarificationSession,
  listImplementationPlans,
  getImplementationPlan,
  listPlanSections,
} from '../../read-models/index.js';
import { parseListParams } from '../query-params.js';
import { RequestValidationError } from '../../errors.js';

function requireProjectId(query: { projectId?: string }): string {
  if (!query.projectId) throw new RequestValidationError('projectId query parameter is required');
  return query.projectId;
}

export function registerPlanningReadRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/specification-inputs',
    async (request, reply) => {
      const projectId = requireProjectId(request.query);
      return reply
        .code(200)
        .send(await listSpecificationInputs(db, projectId, parseListParams(request)));
    },
  );

  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/planning-readiness-assessments',
    async (request, reply) => {
      const projectId = requireProjectId(request.query);
      return reply
        .code(200)
        .send(await listPlanningReadinessAssessments(db, projectId, parseListParams(request)));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/planning-readiness-assessments/:id',
    async (request, reply) => {
      return reply.code(200).send(await getPlanningReadinessAssessment(db, request.params.id));
    },
  );

  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/clarification-sessions',
    async (request, reply) => {
      const projectId = requireProjectId(request.query);
      return reply
        .code(200)
        .send(await listClarificationSessions(db, projectId, parseListParams(request)));
    },
  );

  app.get<{ Params: { id: string } }>('/clarification-sessions/:id', async (request, reply) => {
    return reply.code(200).send(await getClarificationSession(db, request.params.id));
  });

  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/plans',
    async (request, reply) => {
      const projectId = requireProjectId(request.query);
      return reply
        .code(200)
        .send(await listImplementationPlans(db, projectId, parseListParams(request)));
    },
  );

  app.get<{ Params: { id: string } }>('/plans/:id', async (request, reply) => {
    return reply.code(200).send(await getImplementationPlan(db, request.params.id));
  });

  // Additive: `getImplementationPlan()`'s existing shape is a public contract already consumed by
  // the Web UI/CLI (fetchPlanVersion() etc.), so section content is served as a sibling resource
  // rather than widening that response — same "detail as its own endpoint" precedent
  // `/feature-runs/:id/timeline` already established, rather than `GET /clarification-sessions/:id`'s
  // in-place-widened-response precedent, since here an existing consumer already depends on the
  // narrower shape.
  app.get<{ Params: { id: string } }>('/plans/:id/sections', async (request, reply) => {
    return reply.code(200).send({ sections: await listPlanSections(db, request.params.id) });
  });
}
