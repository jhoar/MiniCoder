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

  /**
   * Query-parameter parity (issues found across two rounds of PR #59 review): several read routes
   * accept (or require) `featureRunId`/`projectId`/`adapterId`/`state` at runtime but the
   * hand-authored spec didn't document them — or, for routes that require a parameter, gave no
   * indication it's mandatory at all. Resolves each operation's `$ref`-based parameter list
   * against `components.parameters` and asserts the documented `required` flag matches the route
   * handler's actual behavior (`routes/reads/{agents,artifacts,features,governance,planning,
   * projects,workflow}.ts`) — broader than "did I add the one parameter I just noticed," so a
   * future addition regresses loudly instead of silently.
   */
  it('documents every accepted query parameter (required or optional, matching runtime behavior) on every route', () => {
    const spec = loadOpenApiSpec() as unknown as {
      components: { parameters: Record<string, { name: string; required: boolean }> };
      paths: Record<string, Record<string, { parameters?: Array<{ $ref: string }> }>>;
    };

    function resolvedParamNames(
      path: string,
      method: string,
    ): Array<{ name: string; required: boolean }> {
      const operation = spec.paths[path]?.[method];
      const refs = operation?.parameters ?? [];
      return refs.map((p) => {
        const key = p.$ref.replace('#/components/parameters/', '');
        const resolved = spec.components.parameters[key];
        if (!resolved) throw new Error(`Unresolvable parameter ref: ${p.$ref}`);
        return { name: resolved.name, required: resolved.required };
      });
    }

    const expectations: Array<{ path: string; method: string; name: string; required: boolean }> = [
      // featureRunId
      { path: '/agent-runs', method: 'get', name: 'featureRunId', required: false },
      { path: '/review-findings', method: 'get', name: 'featureRunId', required: true },
      { path: '/disagreements', method: 'get', name: 'featureRunId', required: false },
      { path: '/disagreements', method: 'get', name: 'state', required: false },
      { path: '/workflow-events', method: 'get', name: 'featureRunId', required: false },
      { path: '/merge-gate-evaluations', method: 'get', name: 'featureRunId', required: true },
      { path: '/triggerdev-runs', method: 'get', name: 'featureRunId', required: false },
      // adapterId
      { path: '/agent-configurations', method: 'get', name: 'adapterId', required: false },
      // projectId — optional where the runtime genuinely accepts omission
      { path: '/repositories', method: 'get', name: 'projectId', required: false },
      { path: '/github-links', method: 'get', name: 'projectId', required: false },
      { path: '/agent-runs', method: 'get', name: 'projectId', required: false },
      { path: '/triggerdev-runs', method: 'get', name: 'projectId', required: false },
      { path: '/workflow-events', method: 'get', name: 'projectId', required: false },
      // projectId — required at runtime via each route file's requireProjectId() helper
      { path: '/specification-inputs', method: 'get', name: 'projectId', required: true },
      { path: '/planning-readiness-assessments', method: 'get', name: 'projectId', required: true },
      { path: '/clarification-sessions', method: 'get', name: 'projectId', required: true },
      { path: '/plans', method: 'get', name: 'projectId', required: true },
      { path: '/features', method: 'get', name: 'projectId', required: true },
      { path: '/active-feature', method: 'get', name: 'projectId', required: true },
      { path: '/pull-requests', method: 'get', name: 'projectId', required: true },
      { path: '/human-required-items', method: 'get', name: 'projectId', required: true },
      { path: '/policy-decisions', method: 'get', name: 'projectId', required: true },
      { path: '/costs', method: 'get', name: 'projectId', required: true },
      { path: '/budgets', method: 'get', name: 'projectId', required: true },
      { path: '/artifacts', method: 'get', name: 'projectId', required: true },
      { path: '/design-documents', method: 'get', name: 'projectId', required: true },
      { path: '/status', method: 'get', name: 'projectId', required: true },
    ];

    for (const { path, method, name, required } of expectations) {
      const params = resolvedParamNames(path, method);
      const match = params.find((p) => p.name === name);
      expect(match, `${method.toUpperCase()} ${path} should document '${name}'`).toBeDefined();
      expect(match?.required).toBe(required);
    }
  });
});
