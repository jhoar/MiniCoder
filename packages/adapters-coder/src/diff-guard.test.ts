import { describe, it, expect } from 'vitest';
import { assertDiffWithinBounds, DiffGuardViolationError } from './diff-guard.js';

describe('assertDiffWithinBounds', () => {
  it('passes for a small, allowed diff', () => {
    expect(() =>
      assertDiffWithinBounds([{ path: 'src/widget.ts', bytesChanged: 100 }]),
    ).not.toThrow();
  });

  it('throws when there are no changed files', () => {
    expect(() => assertDiffWithinBounds([])).toThrow(DiffGuardViolationError);
  });

  it('throws when the file count exceeds maxFiles', () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `src/f${i}.ts`,
      bytesChanged: 10,
    }));
    expect(() => assertDiffWithinBounds(files, { maxFiles: 3 })).toThrow(DiffGuardViolationError);
  });

  it('throws when total bytes changed exceeds maxBytes', () => {
    expect(() =>
      assertDiffWithinBounds([{ path: 'src/big.ts', bytesChanged: 1000 }], { maxBytes: 500 }),
    ).toThrow(DiffGuardViolationError);
  });

  it('throws when a changed path matches the default disallowed-path list', () => {
    expect(() =>
      assertDiffWithinBounds([{ path: '.github/workflows/ci.yml', bytesChanged: 10 }]),
    ).toThrow(/disallowed path/);
    expect(() =>
      assertDiffWithinBounds([{ path: 'packages/x/.env', bytesChanged: 10 }]),
    ).toThrow(/disallowed path/);
    expect(() =>
      assertDiffWithinBounds([{ path: 'config/secrets/keys.json', bytesChanged: 10 }]),
    ).toThrow(/disallowed path/);
  });

  it('honors a caller-supplied disallowedPathPatterns list', () => {
    expect(() =>
      assertDiffWithinBounds([{ path: 'src/widget.ts', bytesChanged: 10 }], {
        disallowedPathPatterns: [/^src\//],
      }),
    ).toThrow(DiffGuardViolationError);
  });
});
