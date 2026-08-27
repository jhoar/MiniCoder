import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { buildTestApp } from '../test-helpers.js';

const WEBHOOK_SECRET = 'test-webhook-secret';
const GITEA_WEBHOOK_SECRET = 'test-gitea-webhook-secret';
const GITLAB_WEBHOOK_SECRET = 'test-gitlab-webhook-secret';

function sign(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

/** Gitea's `X-Gitea-Signature` is a bare hex digest, unlike GitHub's `sha256=`-prefixed format. */
function signGitea(body: string): string {
  return crypto.createHmac('sha256', GITEA_WEBHOOK_SECRET).update(body).digest('hex');
}

describe('webhook route mounting', () => {
  it('delegates to registerGithubWebhookRoute — rejects an unsigned/invalid-signature payload', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=deadbeef',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ action: 'opened' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a validly-signed delivery for an unlinked repository (no persistence, still 2xx)', async () => {
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
        'x-github-delivery': 'delivery-2',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sign(body),
        'content-type': 'application/json',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).status).toBe('unlinked-repository');
  });

  it('mounts /webhooks/gitea (opt-in — rejects an unsigned/invalid-signature payload)', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/gitea',
      headers: {
        'x-gitea-delivery': 'delivery-1',
        'x-gitea-event': 'pull_request',
        'x-gitea-signature': 'deadbeef',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ action: 'opened' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('/webhooks/gitea accepts a validly-signed delivery for an unlinked repository (no persistence, still 2xx)', async () => {
    const { app } = await buildTestApp();
    const body = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'example/does-not-exist' },
      pull_request: {
        number: 1,
        head: { ref: 'minicoder/fr-1', sha: 'abc123' },
        base: { ref: 'main' },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/gitea',
      headers: {
        'x-gitea-delivery': 'delivery-2',
        'x-gitea-event': 'pull_request',
        'x-gitea-signature': signGitea(body),
        'content-type': 'application/json',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).status).toBe('unlinked-repository');
  });

  it('mounts /webhooks/gitlab (opt-in — rejects a request with an invalid X-Gitlab-Token)', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab',
      headers: {
        'x-gitlab-token': 'wrong-token',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ object_kind: 'merge_request' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('/webhooks/gitlab accepts a request with a valid X-Gitlab-Token for an unlinked repository (no persistence, still 2xx)', async () => {
    const { app } = await buildTestApp();
    const body = JSON.stringify({
      object_kind: 'merge_request',
      project: { path_with_namespace: 'example/does-not-exist' },
      object_attributes: {
        iid: 1,
        action: 'open',
        source_branch: 'minicoder/fr-1',
        target_branch: 'main',
        last_commit: { id: 'abc123' },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab',
      headers: {
        'x-gitlab-token': GITLAB_WEBHOOK_SECRET,
        'content-type': 'application/json',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).status).toBe('unlinked-repository');
  });
});
