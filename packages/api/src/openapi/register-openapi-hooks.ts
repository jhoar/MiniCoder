import type { FastifyInstance } from 'fastify';
import { RequestValidationError } from '../errors.js';
import { loadOpenApiSpec, isDocumentedRoute, type OpenApiSpec } from './validate-request.js';

/**
 * Registers two things against the hand-authored `openapi/openapi.yaml` contract
 * (docs/01-system-specification.md §9's "OpenAPI-first" requirement):
 *
 *  1. An `onRoute` hook that throws at route-registration time if a route has no matching YAML
 *     operation — spec drift fails the build immediately, not just in a separate test.
 *  2. A `preHandler` hook validating the `limit` query parameter (when present) is a well-formed
 *     integer in [1, 100], matching the spec's declared `limit` parameter schema.
 */
export function registerOpenApiHooks(
  app: FastifyInstance,
  spec: OpenApiSpec = loadOpenApiSpec(),
): void {
  app.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      // Fastify auto-generates a HEAD route for every GET route (exposeHeadRoutes) — this mirrors
      // the GET operation automatically and needs no separate OpenAPI documentation.
      if (method === 'HEAD') continue;
      if (!isDocumentedRoute(spec, method, routeOptions.url)) {
        throw new Error(
          `Route ${method} ${routeOptions.url} has no matching operation in openapi/openapi.yaml — ` +
            'update the spec before registering a new route (docs/01 §9 "OpenAPI-first").',
        );
      }
    }
  });

  app.addHook('preHandler', async (request) => {
    const query = request.query as { limit?: string } | undefined;
    if (query?.limit !== undefined) {
      const n = Number(query.limit);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        throw new RequestValidationError(
          `limit must be an integer between 1 and 100, got '${query.limit}'`,
          'request-does-not-match-schema',
        );
      }
    }
  });
}
