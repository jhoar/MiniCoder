import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import { getFeatureRunTimeline, getBudgetReport } from '../../read-models/index.js';
import { RequestValidationError } from '../../errors.js';

/**
 * Phase 16 observability/cost-reporting reads: the workflow timeline / agent-run trace view
 * (`GET /feature-runs/:id/timeline`) and the budget-forecasting dashboard's aggregate spend
 * breakdown (`GET /budget-report`). Both are plain reads — no role floor beyond ordinary
 * authentication, matching every other read route in this file group.
 */
export function registerObservabilityReadRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Params: { id: string } }>('/feature-runs/:id/timeline', async (request, reply) => {
    return reply.code(200).send(await getFeatureRunTimeline(db, request.params.id));
  });

  app.get<{ Querystring: { projectId?: string; windowDays?: string } }>(
    '/budget-report',
    async (request, reply) => {
      const { projectId, windowDays } = request.query;
      if (!projectId) {
        throw new RequestValidationError('projectId query parameter is required');
      }
      let parsedWindowDays: number | undefined;
      if (windowDays !== undefined) {
        parsedWindowDays = Number(windowDays);
        if (!Number.isFinite(parsedWindowDays) || parsedWindowDays <= 0) {
          throw new RequestValidationError('windowDays must be a positive integer');
        }
      }
      return reply
        .code(200)
        .send(await getBudgetReport(db, { projectId, windowDays: parsedWindowDays }));
    },
  );
}
