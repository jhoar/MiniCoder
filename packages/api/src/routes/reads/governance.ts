import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import {
  listReviewFindings,
  listDisagreements,
  listPolicyDecisions,
  listCostRecords,
  listBudgetPolicies,
} from '../../read-models/index.js';
import { parseListParams } from '../query-params.js';
import { RequestValidationError } from '../../errors.js';

function requireProjectId(query: { projectId?: string }): string {
  if (!query.projectId) throw new RequestValidationError('projectId query parameter is required');
  return query.projectId;
}

export function registerGovernanceReadRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Querystring: { featureRunId?: string; cursor?: string; limit?: string } }>(
    '/review-findings',
    async (request, reply) => {
      if (!request.query.featureRunId) {
        throw new RequestValidationError('featureRunId query parameter is required');
      }
      return reply
        .code(200)
        .send(await listReviewFindings(db, request.query.featureRunId, parseListParams(request)));
    },
  );

  app.get<{
    Querystring: { featureRunId?: string; state?: string; cursor?: string; limit?: string };
  }>('/disagreements', async (request, reply) => {
    const { featureRunId, state } = request.query;
    return reply
      .code(200)
      .send(await listDisagreements(db, { featureRunId, state }, parseListParams(request)));
  });

  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/policy-decisions',
    async (request, reply) => {
      const projectId = requireProjectId(request.query);
      return reply
        .code(200)
        .send(await listPolicyDecisions(db, projectId, parseListParams(request)));
    },
  );

  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/costs',
    async (request, reply) => {
      const projectId = requireProjectId(request.query);
      return reply.code(200).send(await listCostRecords(db, projectId, parseListParams(request)));
    },
  );

  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/budgets',
    async (request, reply) => {
      const projectId = requireProjectId(request.query);
      return reply
        .code(200)
        .send(await listBudgetPolicies(db, projectId, parseListParams(request)));
    },
  );
}
