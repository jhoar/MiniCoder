import { describe, it, expect, vi } from 'vitest';
import { ApiClient } from './api-client';
import { fetchLinkedPullRequest } from './fetch-linked-pull-request';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('fetchLinkedPullRequest', () => {
  it('returns null on a genuine 404 (no PR yet)', async () => {
    const client = new ApiClient({
      baseUrl: 'http://api.local',
      apiKey: 'k',
      fetchImpl: fakeFetch(404, {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'no pull request for this feature run',
      }),
    });

    await expect(fetchLinkedPullRequest(client, 'run-1')).resolves.toBeNull();
  });

  it('rethrows a non-404 failure instead of masking it as "no PR"', async () => {
    const client = new ApiClient({
      baseUrl: 'http://api.local',
      apiKey: 'k',
      fetchImpl: fakeFetch(500, {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'database unavailable',
      }),
    });

    await expect(fetchLinkedPullRequest(client, 'run-1')).rejects.toThrow('database unavailable');
  });
});
