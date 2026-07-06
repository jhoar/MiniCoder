import { describe, it, expect } from 'vitest';
import { HttpReviewProvider } from './http-review-provider.js';

describe('HttpReviewProvider', () => {
  function fakeFetch(diffSeen: { value?: string }) {
    return (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        messages: Array<{ role: string; content: string }>;
      };
      const userMessage = body.messages[1]?.content ?? '';
      diffSeen.value = (JSON.parse(userMessage) as { diff: string }).diff;
      return {
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
      } as Awaited<ReturnType<typeof fetch>>;
    }) as typeof fetch;
  }

  it('sends the real diff to the LLM endpoint but omits it from the persisted promptSnapshot (post-merge review HIGH-1)', async () => {
    const diffSeen: { value?: string } = {};
    const provider = new HttpReviewProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch(diffSeen),
    });

    const realDiff = 'diff --git a/x b/x\n+const apiKey = "sk-fake-secret-1234";\n';
    const result = await provider.review({
      featureTitle: 'Add widget',
      acceptanceCriteria: ['A user can add a widget.'],
      diff: realDiff,
      correlationId: 'corr-1',
    });

    // The actual outbound request to the review provider carries the real diff — the LLM cannot
    // review the change otherwise.
    expect(diffSeen.value).toBe(realDiff);

    expect(result.decision).toBe('approved');
    const snapshot = result.promptSnapshot as { model: string; messages: unknown[] };
    expect(snapshot.model).toBe('test-model');
    expect(snapshot.messages).toHaveLength(2);
    // But the persisted snapshot must never contain the diff body (or anything it might carry,
    // like a secret-shaped string) — only a placeholder pointing at the stored headSha reference.
    const snapshotText = JSON.stringify(snapshot);
    expect(snapshotText).toContain('Add widget');
    expect(snapshotText).not.toContain(realDiff);
    expect(snapshotText).not.toContain('sk-fake-secret-1234');
    expect(snapshotText).toContain('omitted from persisted snapshot');
  });
});
