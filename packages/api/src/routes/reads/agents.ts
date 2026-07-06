import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import {
  listAgentRuns,
  getAgentRun,
  listAgentAdapters,
  listAgentConfigurations,
} from '../../read-models/index.js';
import { parseListParams } from '../query-params.js';

export function registerAgentReadRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{
    Querystring: { projectId?: string; featureRunId?: string; cursor?: string; limit?: string };
  }>('/agent-runs', async (request, reply) => {
    const { projectId, featureRunId } = request.query;
    return reply
      .code(200)
      .send(await listAgentRuns(db, { projectId, featureRunId }, parseListParams(request)));
  });

  app.get<{ Params: { id: string } }>('/agent-runs/:id', async (request, reply) => {
    return reply.code(200).send(await getAgentRun(db, request.params.id));
  });

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/agent-adapters',
    async (request, reply) => {
      return reply.code(200).send(await listAgentAdapters(db, parseListParams(request)));
    },
  );

  app.get<{ Querystring: { adapterId?: string; cursor?: string; limit?: string } }>(
    '/agent-configurations',
    async (request, reply) => {
      return reply
        .code(200)
        .send(await listAgentConfigurations(db, request.query.adapterId, parseListParams(request)));
    },
  );
}
