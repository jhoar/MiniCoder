import { describe, it, expect } from 'vitest';
import { sanitizePromptSnapshot } from './sanitize-prompt-snapshot.js';

describe('sanitizePromptSnapshot (post-merge PR review fix, LOW-1)', () => {
  it('replaces a literal diff key regardless of nesting depth', () => {
    const result = sanitizePromptSnapshot({
      model: 'test-model',
      messages: [{ role: 'user', diff: 'diff --git a/x b/x\n+secret=abc123\n' }],
    }) as { messages: Array<{ diff: string }> };

    expect(result.messages[0]?.diff).not.toContain('secret=abc123');
    expect(result.messages[0]?.diff).toContain('omitted');
  });

  it('replaces a unified-diff-shaped string even without a literal diff key', () => {
    const result = sanitizePromptSnapshot({
      body: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
    }) as { body: string };

    expect(result.body).not.toContain('diff --git');
    expect(result.body).toContain('omitted');
  });

  it('parses JSON-encoded string content and sanitizes a diff field nested inside it', () => {
    const rawContent = JSON.stringify({
      featureTitle: 'Add widget',
      diff: 'diff --git a/x b/x\n+const apiKey = "sk-fake-secret";\n',
    });
    const result = sanitizePromptSnapshot({
      messages: [{ role: 'user', content: rawContent }],
    }) as { messages: Array<{ content: string }> };

    const parsedBack = JSON.parse(result.messages[0]!.content) as {
      featureTitle: string;
      diff: string;
    };
    expect(parsedBack.featureTitle).toBe('Add widget');
    expect(parsedBack.diff).not.toContain('sk-fake-secret');
    expect(result.messages[0]!.content).not.toContain('sk-fake-secret');
  });

  it('leaves ordinary, non-diff-shaped strings and objects untouched', () => {
    const input = {
      model: 'test-model',
      featureTitle: 'Add widget',
      acceptanceCriteria: ['A user can add a widget.'],
    };
    expect(sanitizePromptSnapshot(input)).toEqual(input);
  });

  it('never throws — falls back to a placeholder on unexpected shapes', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => sanitizePromptSnapshot(circular)).not.toThrow();
  });
});
