import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import {
  listArtifactExports,
  getArtifactExport,
  listDesignDocuments,
  getDesignDocument,
} from '../../read-models/index.js';
import { parseListParams } from '../query-params.js';
import { RequestValidationError } from '../../errors.js';

function requireProjectId(query: { projectId?: string }): string {
  if (!query.projectId) throw new RequestValidationError('projectId query parameter is required');
  return query.projectId;
}

export function registerArtifactReadRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/artifacts',
    async (request, reply) => {
      const projectId = requireProjectId(request.query);
      return reply
        .code(200)
        .send(await listArtifactExports(db, projectId, parseListParams(request)));
    },
  );

  app.get<{ Params: { id: string } }>('/artifacts/:id', async (request, reply) => {
    return reply.code(200).send(await getArtifactExport(db, request.params.id));
  });

  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/design-documents',
    async (request, reply) => {
      const projectId = requireProjectId(request.query);
      return reply
        .code(200)
        .send(await listDesignDocuments(db, projectId, parseListParams(request)));
    },
  );

  app.get<{ Params: { id: string } }>('/design-documents/:id', async (request, reply) => {
    return reply.code(200).send(await getDesignDocument(db, request.params.id));
  });
}
