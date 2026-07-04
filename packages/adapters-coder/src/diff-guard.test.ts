import { describe, it, expect } from 'vitest';
import {
  assertDiffWithinBounds,
  validateRelativePath,
  DiffGuardViolationError,
} from './diff-guard.js';

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
    expect(() => assertDiffWithinBounds([{ path: 'packages/x/.env', bytesChanged: 10 }])).toThrow(
      /disallowed path/,
    );
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

describe('validateRelativePath (HIGH-3 code-review fix)', () => {
  it('accepts a normal relative path unchanged', () => {
    expect(validateRelativePath('src/widget.ts')).toBe('src/widget.ts');
  });

  it('normalizes a redundant but safe path', () => {
    expect(validateRelativePath('./src/./widget.ts')).toBe('src/widget.ts');
    expect(validateRelativePath('src/sub/../widget.ts')).toBe('src/widget.ts');
  });

  it('rejects a path that escapes the repo root via ..', () => {
    expect(validateRelativePath('../outside')).toBeNull();
    expect(validateRelativePath('src/../../outside')).toBeNull();
  });

  it('rejects an absolute POSIX path', () => {
    expect(validateRelativePath('/tmp/x')).toBeNull();
  });

  it('rejects an absolute Windows-drive path', () => {
    expect(validateRelativePath('C:\\Windows\\x')).toBeNull();
  });

  it('rejects a path that normalizes into a disallowed path', () => {
    expect(validateRelativePath('foo/../.git/config')).toBeNull();
    expect(validateRelativePath('.github/workflows/evil.yml')).toBeNull();
  });

  it('rejects an empty or root-only path', () => {
    expect(validateRelativePath('')).toBeNull();
    expect(validateRelativePath('.')).toBeNull();
    expect(validateRelativePath('./')).toBeNull();
  });
});
