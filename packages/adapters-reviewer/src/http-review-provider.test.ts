import { describe, it, expect } from 'vitest';
import { HttpReviewProvider } from './http-review-provider.js';

describe('HttpReviewProvider', () => {
  it('returns the exact assembled request body as promptSnapshot (issue #49)', async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ decision: 'approved', findings: [] }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      }) as Awaited<ReturnType<typeof fetch>>) as typeof fetch;

    const provider = new HttpReviewProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch,
    });

    const result = await provider.review({
      featureTitle: 'Add widget',
      acceptanceCriteria: ['A user can add a widget.'],
      diff: 'diff --git a/x b/x\n',
      correlationId: 'corr-1',
    });

    expect(result.decision).toBe('approved');
    const snapshot = result.promptSnapshot as { model: string; messages: unknown[] };
    expect(snapshot.model).toBe('test-model');
    expect(snapshot.messages).toHaveLength(2);
    expect(JSON.stringify(snapshot)).toContain('Add widget');
  });
});
