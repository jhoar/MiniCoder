import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import {
  listFeatureRequests,
  getFeatureRequest,
  getFeatureRun,
  getActiveFeature,
  getPullRequestByFeatureRun,
  listPullRequests,
  listHumanRequiredItems,
} from '../../read-models/index.js';
import { parseListParams } from '../query-params.js';
import { RequestValidationError } from '../../errors.js';

function requireProjectId(query: { projectId?: string }): string {
  if (!query.projectId) throw new RequestValidationError('projectId query parameter is required');
  return query.projectId;
}

export function registerFeatureReadRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/features',
    async (request, reply) => {
      const projectId = requireProjectId(request.query);
      return reply
        .code(200)
        .send(await listFeatureRequests(db, projectId, parseListParams(request)));
    },
  );

  app.get<{ Params: { id: string } }>('/features/:id', async (request, reply) => {
    return reply.code(200).send(await getFeatureRequest(db, request.params.id));
  });

  app.get<{ Params: { id: string } }>('/feature-runs/:id', async (request, reply) => {
    return reply.code(200).send(await getFeatureRun(db, request.params.id));
  });

  app.get<{ Querystring: { projectId?: string } }>('/active-feature', async (request, reply) => {
    const projectId = requireProjectId(request.query);
    return reply.code(200).send(await getActiveFeature(db, projectId));
  });

  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/pull-requests',
    async (request, reply) => {
      const projectId = requireProjectId(request.query);
      return reply.code(200).send(await listPullRequests(db, projectId, parseListParams(request)));
    },
  );

  app.get<{ Params: { featureRunId: string } }>(
    '/feature-runs/:featureRunId/pull-request',
    async (request, reply) => {
      return reply
        .code(200)
        .send(await getPullRequestByFeatureRun(db, request.params.featureRunId));
    },
  );

  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/human-required-items',
    async (request, reply) => {
      const projectId = requireProjectId(request.query);
      return reply
        .code(200)
        .send(await listHumanRequiredItems(db, projectId, parseListParams(request)));
    },
  );
}
