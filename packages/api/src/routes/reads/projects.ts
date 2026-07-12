import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import { evaluateProjectAcceptance } from '@minicoder/core';
import {
  listProjects,
  getProject,
  listRepositories,
  listGithubLinks,
} from '../../read-models/index.js';
import { parseListParams } from '../query-params.js';
import { RequestValidationError } from '../../errors.js';

export function registerProjectReadRoutes(app: FastifyInstance, db: DbClient): void {
  app.get('/projects', async (request, reply) => {
    return reply.code(200).send(await listProjects(db, parseListParams(request)));
  });

  app.get<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    return reply.code(200).send(await getProject(db, request.params.id));
  });

  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/repositories',
    async (request, reply) => {
      return reply
        .code(200)
        .send(await listRepositories(db, request.query.projectId, parseListParams(request)));
    },
  );

  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/github-links',
    async (request, reply) => {
      return reply
        .code(200)
        .send(await listGithubLinks(db, request.query.projectId, parseListParams(request)));
    },
  );

  // Phase 17: a plain, pure-DB read of Project Acceptance Validation (docs/01 §13.1) — the same
  // DB-knowable checks `MarkImplementationCompleteHandler` itself gates on, exposed so an
  // operator/CLI can inspect readiness *before* attempting the transition (and see, honestly,
  // which checks this endpoint cannot itself verify — see `evaluateProjectAcceptance()`'s own doc
  // comment). Any authenticated role may read it (mirrors every other project-scoped read route).
  app.get<{ Querystring: { projectId?: string } }>(
    '/project-acceptance',
    async (request, reply) => {
      const { projectId } = request.query;
      if (!projectId) {
        throw new RequestValidationError('projectId query parameter is required');
      }
      return reply.code(200).send(await evaluateProjectAcceptance(db, projectId));
    },
  );
}
