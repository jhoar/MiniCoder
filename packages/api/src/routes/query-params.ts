import type { FastifyRequest } from 'fastify';
import type { ListParams } from '../pagination.js';

export function parseListParams(request: FastifyRequest): ListParams {
  const query = request.query as { cursor?: string; limit?: string };
  return {
    cursor: query.cursor,
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
  };
}
