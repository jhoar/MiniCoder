import { describe, it, expect } from 'vitest';
import { loadOpenApiSpec, isDocumentedRoute, allDocumentedOperations } from './validate-request.js';
import { buildTestApp, TEST_OPERATOR_KEY } from '../test-helpers.js';

describe('OpenAPI conformance', () => {
  it('parses the hand-authored spec and exposes an openapi version + paths', () => {
    const spec = loadOpenApiSpec();
    expect(spec.openapi).toMatch(/^3\.1/);
    expect(Object.keys(spec.paths).length).toBeGreaterThan(10);
  });

  it('recognizes both static and parametric route documentation', () => {
    const spec = loadOpenApiSpec();
    expect(isDocumentedRoute(spec, 'GET', '/projects')).toBe(true);
    expect(isDocumentedRoute(spec, 'GET', '/projects/:id')).toBe(true);
    expect(isDocumentedRoute(spec, 'POST', '/commands/:commandSlug')).toBe(true);
    expect(isDocumentedRoute(spec, 'GET', '/not-a-real-route')).toBe(false);
  });

  it('building the app succeeds — every registered route matches a documented operation', async () => {
    // registerOpenApiHooks's onRoute hook throws synchronously if any route lacks a matching
    // spec entry, so a successful buildApp() call is itself the "every route is documented" proof.
    const { app } = await buildTestApp();
    expect(app).toBeDefined();
  });

  it('rejects limit values outside [1, 100] per the documented parameter schema', async () => {
    const { app } = await buildTestApp();
    const tooHigh = await app.inject({
      method: 'GET',
      url: '/projects?limit=1000',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(tooHigh.statusCode).toBe(400);
    expect(JSON.parse(tooHigh.body).type).toBe('request-does-not-match-schema');
  });

  it('every documented operation set is non-empty and includes the webhook route', () => {
    const spec = loadOpenApiSpec();
    const ops = allDocumentedOperations(spec);
    expect(ops.has('POST /webhooks/github')).toBe(true);
    expect(ops.has('GET /healthz')).toBe(true);
  });
});
