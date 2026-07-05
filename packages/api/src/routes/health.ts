import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', async (_request, reply) => reply.code(200).send({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => reply.code(200).send({ status: 'ok' }));
}
