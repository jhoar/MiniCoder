import { describe, it, expect, vi } from 'vitest';
import { ApiClient, ApiError } from './api-client';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('ApiClient', () => {
  it('sends Authorization and Idempotency-Key headers on a command POST', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
      expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBe('abc123');
      return new Response(
        JSON.stringify({
          command_id: '1',
          accepted: true,
          resulting_state: 'x',
          emitted_event_ids: [],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new ApiClient({ baseUrl: 'http://api.local', apiKey: 'test-key', fetchImpl });
    const result = await client.selectFeature(
      { featureRunId: 'fr1', projectId: 'p1', expectedVersion: 1 },
      'abc123',
    );
    expect(result.accepted).toBe(true);
  });

  it('parses a GET response and includes query params', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('projectId=p1');
      return new Response(JSON.stringify({ items: [], nextCursor: undefined }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ApiClient({ baseUrl: 'http://api.local', apiKey: 'k', fetchImpl });
    const page = await client.listFeatures('p1');
    expect(page.items).toEqual([]);
  });

  it('throws a typed ApiError with the parsed RFC 9457 problem body on a non-2xx response', async () => {
    const problem = {
      type: 'not-found',
      title: 'Not Found',
      status: 404,
      detail: 'feature-run not-found',
    };
    const client = new ApiClient({
      baseUrl: 'http://api.local',
      apiKey: 'k',
      fetchImpl: fakeFetch(404, problem),
    });

    await expect(client.getFeatureRun('missing')).rejects.toMatchObject({
      status: 404,
      problem: { detail: 'feature-run not-found' },
    });
    await expect(client.getFeatureRun('missing')).rejects.toBeInstanceOf(ApiError);
  });

  it('falls back to a synthetic problem detail when the error body is not RFC 9457 shaped', async () => {
    const client = new ApiClient({
      baseUrl: 'http://api.local',
      apiKey: 'k',
      fetchImpl: fakeFetch(500, { unexpected: 'shape' }),
    });

    await expect(client.getFeatureRun('x')).rejects.toMatchObject({
      status: 500,
      problem: { type: 'unknown-error' },
    });
  });

  it('findPullRequestByNumber paginates until it finds a match', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ items: [{ pr_number: 1 }], nextCursor: 'page2' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ items: [{ pr_number: 7 }], nextCursor: undefined }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const client = new ApiClient({ baseUrl: 'http://api.local', apiKey: 'k', fetchImpl });
    const found = await client.findPullRequestByNumber('p1', 7);
    expect(found).toMatchObject({ pr_number: 7 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('findPullRequestByNumber returns null when no page matches', async () => {
    const fetchImpl = fakeFetch(200, { items: [{ pr_number: 1 }], nextCursor: undefined });
    const client = new ApiClient({ baseUrl: 'http://api.local', apiKey: 'k', fetchImpl });
    const found = await client.findPullRequestByNumber('p1', 999);
    expect(found).toBeNull();
  });
});
