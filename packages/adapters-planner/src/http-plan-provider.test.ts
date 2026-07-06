import { describe, it, expect } from 'vitest';
import { HttpPlanProvider } from './http-plan-provider.js';

function fakeFetch(content: unknown, usage?: { prompt_tokens: number; completion_tokens: number }) {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage,
      }),
    }) as Awaited<ReturnType<typeof fetch>>) as typeof fetch;
}

describe('HttpPlanProvider', () => {
  it('assessReadiness returns the parsed result plus promptSnapshot', async () => {
    const provider = new HttpPlanProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch(
        {
          readinessResult: 'sufficient',
          questions: [],
          assumptions: [],
          gaps: [],
        },
        { prompt_tokens: 10, completion_tokens: 5 },
      ),
    });

    const result = await provider.assessReadiness({
      specificationContent: 'Build a widget.',
      correlationId: 'corr-1',
    });

    expect(result.readinessResult).toBe('sufficient');
    expect(result.tokensUsed).toEqual({ input: 10, output: 5 });
    const snapshot = result.promptSnapshot as { model: string; messages: unknown[] };
    expect(snapshot.model).toBe('test-model');
    expect(JSON.stringify(snapshot)).toContain('Build a widget.');
  });

  it('assessReadiness throws on an invalid readinessResult', async () => {
    const provider = new HttpPlanProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch({ readinessResult: 'maybe' }),
    });

    await expect(
      provider.assessReadiness({ specificationContent: 'x', correlationId: 'corr-1' }),
    ).rejects.toThrow(/invalid shape/);
  });

  it('assessReadiness throws on a malformed nested gap (post-merge review MEDIUM-2)', async () => {
    const provider = new HttpPlanProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch({
        readinessResult: 'sufficient',
        questions: [],
        assumptions: [],
        gaps: [{ description: 'Missing NFRs', severity: 'extremely-blocking' }],
      }),
    });

    await expect(
      provider.assessReadiness({ specificationContent: 'x', correlationId: 'corr-1' }),
    ).rejects.toThrow(/invalid shape/);
  });

  it('generatePlanSections returns title/sections', async () => {
    const provider = new HttpPlanProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch({
        title: 'Plan',
        summary: 'A summary',
        sections: [{ title: 'Overview', content: 'Some content.' }],
      }),
    });

    const result = await provider.generatePlanSections({
      specificationContent: 'Build a widget.',
      correlationId: 'corr-1',
    });

    expect(result.title).toBe('Plan');
    expect(result.sections).toEqual([{ title: 'Overview', content: 'Some content.' }]);
  });

  it('generatePlanSections throws when title/sections are missing', async () => {
    const provider = new HttpPlanProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch({}),
    });

    await expect(
      provider.generatePlanSections({ specificationContent: 'x', correlationId: 'corr-1' }),
    ).rejects.toThrow(/invalid shape/);
  });

  it('generateFeatureBacklog returns features', async () => {
    const provider = new HttpPlanProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch({
        features: [
          {
            frId: 'FR-001',
            title: 'Add widget',
            description: 'A widget.',
            kind: 'feature',
            priority: 0,
            dependsOnFrIds: [],
            acceptanceCriteria: ['A user can add a widget.'],
            testExpectations: [{ description: 'Covered.', testType: 'unit' }],
          },
        ],
      }),
    });

    const result = await provider.generateFeatureBacklog({
      planSections: [{ title: 'Overview', content: 'Some content.' }],
      correlationId: 'corr-1',
    });

    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.frId).toBe('FR-001');
  });

  it('generateFeatureBacklog throws when features is missing', async () => {
    const provider = new HttpPlanProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch({}),
    });

    await expect(
      provider.generateFeatureBacklog({ planSections: [], correlationId: 'corr-1' }),
    ).rejects.toThrow(/invalid shape/);
  });

  it('generateFeatureBacklog throws on a malformed nested testExpectations entry (post-merge review MEDIUM-2)', async () => {
    const provider = new HttpPlanProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: fakeFetch({
        features: [
          {
            frId: 'FR-001',
            title: 'Add widget',
            description: 'A widget.',
            kind: 'feature',
            priority: 0,
            dependsOnFrIds: [],
            acceptanceCriteria: ['A user can add a widget.'],
            testExpectations: [{ description: 'Covered.', testType: 'not-a-real-test-type' }],
          },
        ],
      }),
    });

    await expect(
      provider.generateFeatureBacklog({ planSections: [], correlationId: 'corr-1' }),
    ).rejects.toThrow(/invalid shape/);
  });

  it('applies a request timeout via AbortSignal', async () => {
    let sawSignal: AbortSignal | undefined;
    const provider = new HttpPlanProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      timeoutMs: 5,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sawSignal = init.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('The operation was aborted.')),
          );
        });
      }) as typeof fetch,
    });

    await expect(
      provider.assessReadiness({ specificationContent: 'x', correlationId: 'corr-1' }),
    ).rejects.toThrow();
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it('throws on a non-ok HTTP response', async () => {
    const provider = new HttpPlanProvider({
      baseUrl: 'https://example.test',
      apiKey: 'key',
      model: 'test-model',
      fetchImpl: (async () =>
        ({ ok: false, status: 500 }) as Awaited<ReturnType<typeof fetch>>) as typeof fetch,
    });

    await expect(
      provider.assessReadiness({ specificationContent: 'x', correlationId: 'corr-1' }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
