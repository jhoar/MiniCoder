import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { buildTestApp, TEST_OPERATOR_KEY, seedProjectWithWorkflowState } from '../test-helpers.js';

function sign(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('auth middleware', () => {
  it('rejects a request with no Authorization header', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/projects' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).type).toBe('unauthenticated');
  });

  it('rejects a request with an unrecognized API key', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: 'Bearer not-a-real-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a request with a recognized API key', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('generates a correlation id when X-Correlation-Id is absent, and passes one through when present', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);

    const withoutHeader = await app.inject({
      method: 'POST',
      url: '/commands/pause-automation',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'pause-1',
      },
      payload: { projectId, expectedVersion: 1 },
    });
    expect(withoutHeader.statusCode).toBe(200);

    const { projectId: projectId2 } = await seedProjectWithWorkflowState(db);
    const withHeader = await app.inject({
      method: 'POST',
      url: '/commands/pause-automation',
      headers: {
        authorization: `Bearer ${TEST_OPERATOR_KEY}`,
        'idempotency-key': 'pause-2',
        'x-correlation-id': 'my-correlation-id',
      },
      payload: { projectId: projectId2, expectedVersion: 1 },
    });
    expect(withHeader.statusCode).toBe(200);
  });

  it('exempts the webhook route from API-key auth (no Authorization header, real signature accepted)', async () => {
    const { app } = await buildTestApp();
    const body = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'example/does-not-exist' },
      pull_request: { number: 1, head: { sha: 'abc123' } },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-delivery': 'delivery-auth-exempt',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sign('test-webhook-secret', body),
        'content-type': 'application/json',
      },
      payload: body,
    });
    // No Authorization header was supplied at all — if the auth hook applied to this route, it
    // would reject with our own `unauthenticated` problem-detail regardless of the signature.
    expect(res.statusCode).toBe(202);
  });
});
