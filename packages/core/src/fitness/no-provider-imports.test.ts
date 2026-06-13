import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Architectural fitness test: packages/core must never import provider SDKs or DB drivers.
 * This test scans all .ts files in core/src (excluding config/ which may read process.env,
 * and test files) and asserts no banned imports are present.
 */

const CORE_SRC = path.resolve(__dirname, '../../');
const BANNED_IMPORTS = [
  'better-sqlite3',
  "'pg'",
  '"pg"',
  'mysql',
  'openai',
  '@anthropic-ai',
  '@google-ai',
  'cohere',
  'replicate',
  'langchain',
];

function collectTsFiles(dir: string, exclude: string[] = []): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!exclude.some((ex) => fullPath.endsWith(ex))) {
        results.push(...collectTsFiles(fullPath, exclude));
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Architectural fitness: packages/core has no provider/DB imports', () => {
  const files = collectTsFiles(CORE_SRC);

  it('should find TypeScript source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const banned of BANNED_IMPORTS) {
    it(`no file in core/src imports '${banned}'`, () => {
      const violations: string[] = [];
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        if (content.includes(banned)) {
          violations.push(path.relative(CORE_SRC, file));
        }
      }
      expect(violations, `Files importing '${banned}': ${violations.join(', ')}`).toEqual([]);
    });
  }
});
