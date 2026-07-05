import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import {
  listProjects,
  getProject,
  listRepositories,
  listGithubLinks,
} from '../../read-models/index.js';
import { parseListParams } from '../query-params.js';

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
}
