import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import {
  listWorkflowEvents,
  listMergeGateEvaluations,
  getProjectStatus,
  listTriggerdevRuns,
} from '../../read-models/index.js';
import { parseListParams } from '../query-params.js';
import { RequestValidationError } from '../../errors.js';

export function registerWorkflowReadRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{
    Querystring: { projectId?: string; featureRunId?: string; cursor?: string; limit?: string };
  }>('/workflow-events', async (request, reply) => {
    const { projectId, featureRunId } = request.query;
    return reply
      .code(200)
      .send(await listWorkflowEvents(db, { projectId, featureRunId }, parseListParams(request)));
  });

  app.get<{ Querystring: { featureRunId?: string; cursor?: string; limit?: string } }>(
    '/merge-gate-evaluations',
    async (request, reply) => {
      if (!request.query.featureRunId) {
        throw new RequestValidationError('featureRunId query parameter is required');
      }
      return reply
        .code(200)
        .send(
          await listMergeGateEvaluations(db, request.query.featureRunId, parseListParams(request)),
        );
    },
  );

  app.get<{ Querystring: { projectId?: string } }>('/status', async (request, reply) => {
    if (!request.query.projectId) {
      throw new RequestValidationError('projectId query parameter is required');
    }
    return reply.code(200).send(await getProjectStatus(db, request.query.projectId));
  });

  app.get<{
    Querystring: { projectId?: string; featureRunId?: string; cursor?: string; limit?: string };
  }>('/triggerdev-runs', async (request, reply) => {
    const { projectId, featureRunId } = request.query;
    return reply
      .code(200)
      .send(await listTriggerdevRuns(db, { projectId, featureRunId }, parseListParams(request)));
  });
}
