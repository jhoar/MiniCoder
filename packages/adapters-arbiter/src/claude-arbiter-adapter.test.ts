import { describe, it, expect } from 'vitest';
import type { ArbiterInput } from '@minicoder/core';
import { ClaudeArbiterAdapter } from './claude-arbiter-adapter.js';
import type { ArbiterProvider, ArbitrationRequest } from './arbiter-provider.js';

function baseInput(overrides: Partial<ArbiterInput> = {}): ArbiterInput {
  return {
    projectId: 'proj-1',
    featureRunId: 'run-1',
    findingDescription: 'The API returns a 500 on empty input.',
    coderPosition: "Coder's last response was 'fixed'.",
    reviewerPosition: 'The API returns a 500 on empty input.',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('ClaudeArbiterAdapter', () => {
  it('delegates to the injected ArbiterProvider and passes the finding/positions through', async () => {
    let seenRequest: ArbitrationRequest | undefined;
    const provider: ArbiterProvider = {
      async arbitrate(request) {
        seenRequest = request;
        return { resolution: 'reviewer_correct', notes: 'Still broken.' };
      },
    };
    const adapter = new ClaudeArbiterAdapter({ arbiterProvider: provider });

    const output = await adapter.run(baseInput());

    expect(seenRequest?.findingDescription).toBe('The API returns a 500 on empty input.');
    expect(seenRequest?.coderPosition).toBe("Coder's last response was 'fixed'.");
    expect(seenRequest?.reviewerPosition).toBe('The API returns a 500 on empty input.');
    expect(output.resolution).toBe('reviewer_correct');
    expect(output.notes).toBe('Still broken.');
  });

  it('passes through tokensUsed/promptSnapshot for cost/audit provenance', async () => {
    const provider: ArbiterProvider = {
      async arbitrate() {
        return {
          resolution: 'compromise',
          notes: 'Split the difference.',
          tokensUsed: { input: 20, output: 8 },
          promptSnapshot: { model: 'test-model' },
        };
      },
    };
    const adapter = new ClaudeArbiterAdapter({ arbiterProvider: provider });

    const output = await adapter.run(baseInput());

    expect(output.tokensUsed).toEqual({ input: 20, output: 8 });
    expect(output.promptSnapshot).toEqual({ model: 'test-model' });
  });
});
