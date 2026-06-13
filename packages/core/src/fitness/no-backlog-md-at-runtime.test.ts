import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Architectural fitness test: no source file may read backlog.md at runtime.
 * backlog.md is a generated artifact snapshot — never runtime state.
 * (docs/CLAUDE.md §Key Architectural Decisions, decision 8)
 */

const PACKAGES_ROOT = path.resolve(__dirname, '../../../../');

const BANNED_PATTERNS = [
  /readFileSync\s*\([^)]*backlog\.md/,
  /readFile\s*\([^)]*backlog\.md/,
  /require\s*\([^)]*backlog\.md/,
  /import\s*\([^)]*backlog\.md/,
];

function collectTsFiles(dir: string, exclude: string[] = []): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const shouldExclude = exclude.some((ex) => fullPath.endsWith(ex) || entry.name === ex);
      if (!shouldExclude) {
        results.push(...collectTsFiles(fullPath, exclude));
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Architectural fitness: no source reads backlog.md at runtime', () => {
  const files = collectTsFiles(PACKAGES_ROOT, ['node_modules', 'dist']);

  it('should find TypeScript source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no file reads backlog.md at runtime', () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const pattern of BANNED_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(path.relative(PACKAGES_ROOT, file));
          break;
        }
      }
    }
    expect(violations, `Files reading backlog.md at runtime: ${violations.join(', ')}`).toEqual([]);
  });
});
