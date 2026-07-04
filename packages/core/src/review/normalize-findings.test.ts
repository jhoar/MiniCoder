import { describe, it, expect } from 'vitest';
import { normalizeReviewerFindings, ReviewFindingInsertSchema } from './normalize-findings.js';
import type { ReviewerOutput } from '../adapters/types.js';

describe('normalizeReviewerFindings', () => {
  it('accepts all 6 FindingSeverity values', () => {
    const output: ReviewerOutput = {
      decision: 'changes_requested',
      findings: [
        { severity: 'blocking', category: 'correctness', description: 'a' },
        { severity: 'non_blocking', category: 'style', description: 'b' },
        { severity: 'nit', category: 'style', description: 'c' },
        { severity: 'question', category: 'clarity', description: 'd' },
        { severity: 'out_of_scope', category: 'scope', description: 'e' },
        { severity: 'requires_human_decision', category: 'policy', description: 'f' },
      ],
    };
    const normalized = normalizeReviewerFindings(output);
    expect(normalized).toHaveLength(6);
    expect(normalized.map((f) => f.severity)).toEqual([
      'blocking',
      'non_blocking',
      'nit',
      'question',
      'out_of_scope',
      'requires_human_decision',
    ]);
  });

  it('rejects a malformed severity', () => {
    expect(() =>
      ReviewFindingInsertSchema.parse({
        severity: 'not-a-real-severity',
        category: 'x',
        description: 'y',
      }),
    ).toThrow();
  });

  it('rejects a missing description', () => {
    expect(() =>
      ReviewFindingInsertSchema.parse({ severity: 'blocking', category: 'x', description: '' }),
    ).toThrow();
  });

  it('passes through optional filePath/lineStart/lineEnd', () => {
    const output: ReviewerOutput = {
      decision: 'changes_requested',
      findings: [
        {
          severity: 'blocking',
          category: 'correctness',
          description: 'bug',
          filePath: 'src/foo.ts',
          lineStart: 10,
          lineEnd: 12,
        },
      ],
    };
    const normalized = normalizeReviewerFindings(output);
    expect(normalized[0]?.filePath).toBe('src/foo.ts');
    expect(normalized[0]?.lineStart).toBe(10);
    expect(normalized[0]?.lineEnd).toBe(12);
  });
});
