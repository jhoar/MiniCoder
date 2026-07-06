import { describe, it, expect } from 'vitest';
import { HttpArbiterProvider } from './http-arbiter-provider.js';

function fakeFetch(body: { ok: boolean; status?: number; content?: unknown }) {
  return (async () =>
    ({
      ok: body.ok,
      status: body.status ?? 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(body.content) } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }),
    }) as Awaited<ReturnType<typeof fetch>>) as typeof fetch;
}

describe('HttpArbiterProvider', () => {
  it('returns the parsed resolution/notes plus promptSnapshot', async () => {
    const provider = new HttpArbiterProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch({
        ok: true,
        content: { resolution: 'coder_correct', notes: 'The reviewer misread the diff.' },
      }),
    });

    const result = await provider.arbitrate({
      findingDescription: 'The API returns a 500 on empty input.',
      coderPosition: 'Fixed in the last push.',
      reviewerPosition: 'Still reproduces.',
      correlationId: 'corr-1',
    });

    expect(result.resolution).toBe('coder_correct');
    expect(result.tokensUsed).toEqual({ input: 12, output: 4 });
    const snapshot = result.promptSnapshot as { model: string; messages: unknown[] };
    expect(snapshot.model).toBe('test-model');
    expect(JSON.stringify(snapshot)).toContain('500 on empty input');
  });

  it('throws on an invalid resolution', async () => {
    const provider = new HttpArbiterProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch({ ok: true, content: { resolution: 'maybe' } }),
    });

    await expect(
      provider.arbitrate({
        findingDescription: 'x',
        coderPosition: 'x',
        reviewerPosition: 'x',
        correlationId: 'corr-1',
      }),
    ).rejects.toThrow(/invalid resolution/);
  });

  it('throws on a non-ok HTTP response', async () => {
    const provider = new HttpArbiterProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch({ ok: false, status: 503 }),
    });

    await expect(
      provider.arbitrate({
        findingDescription: 'x',
        coderPosition: 'x',
        reviewerPosition: 'x',
        correlationId: 'corr-1',
      }),
    ).rejects.toThrow(/HTTP 503/);
  });
});
