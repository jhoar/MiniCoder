import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Architectural fitness test (MEDIUM-2 code-review fix, round 5): guards against
 * `conversationsResolved`/`conversations_resolved` being silently wired into a real merge/review
 * decision before Phase 12 (Merge Gate) exists.
 *
 * `OctokitGitHubClient.getPullRequest()` currently reports `conversationsResolved: false` as a
 * conservative, fail-closed *placeholder* — GitHub's REST API has no "conversations resolved"
 * flag at all (only GraphQL's `reviewThreads.nodes[].isResolved` exposes it), so this value is
 * never a real observation (see the code comment in `packages/github/src/octokit-client.ts` and
 * docs/01-system-specification.md §5.7/§5.10). Nothing in the codebase today gates a
 * merge/review decision on it — `syncPullRequestObservedState` only mirrors it onto
 * `pull_requests.conversations_resolved`, it never branches on it.
 *
 * This test scans decision-relevant source directories (command handlers, and once it exists,
 * merge-gate-adjacent code) for any reference to `conversationsResolved`/`conversations_resolved`
 * outside an explicit allow-list of the known storage/sync files that already legitimately
 * mention it (mirroring/persisting the observed value, not gating a decision on it). Adding a new
 * reference outside the allow-list fails this test, forcing a deliberate, visible decision
 * (updating the allow-list here) the day a future Phase 12 merge-gate implementer wires this
 * field into a real gate, rather than letting it happen silently.
 */

const CORE_HANDLERS_SRC = path.resolve(__dirname, '../commands/handlers');
const CORE_GITHUB_SRC = path.resolve(__dirname, '../github');
// __dirname is packages/core/src/fitness; '../../..' reaches packages/, then 'github/src'.
const GITHUB_PACKAGE_SRC = path.resolve(__dirname, '../../../github/src');

const PATTERN = /conversationsResolved|conversations_resolved/;

/**
 * Files that legitimately reference the field today: they observe it (octokit-client.ts), define
 * the interface field (client.ts), or persist/mirror it verbatim without branching a
 * merge/review decision on its value (pull-request-row.ts, reconcile.ts's doc comments).
 * `inbox-handlers.ts`/`normalize.ts` each mention it once in a doc comment explaining *why* a
 * webhook event is surfaced for reconciliation (conversation-thread activity potentially
 * affecting a future `conversations_resolved` observation) — neither file reads or branches on
 * the field's value.
 */
const ALLOWED_BASENAMES = new Set([
  'pull-request-row.ts',
  'reconcile.ts',
  'client.ts',
  'octokit-client.ts',
  'inbox-handlers.ts',
  'normalize.ts',
]);

function collectTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Architectural fitness: conversationsResolved is not yet consumed by a decision', () => {
  const scanDirs = [CORE_HANDLERS_SRC, CORE_GITHUB_SRC, GITHUB_PACKAGE_SRC];
  const files = scanDirs.flatMap((dir) => collectTsFiles(dir));

  it('scan directories are reachable', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no non-allow-listed file references conversationsResolved/conversations_resolved', () => {
    const violations: string[] = [];
    for (const file of files) {
      const basename = path.basename(file);
      if (ALLOWED_BASENAMES.has(basename)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      if (PATTERN.test(content)) {
        violations.push(path.relative(path.resolve(__dirname, '../../../..'), file));
      }
    }
    expect(
      violations,
      `Files referencing conversationsResolved/conversations_resolved outside the allow-list ` +
        `(update ALLOWED_BASENAMES in this test if this is a deliberate Phase 12 merge-gate wiring): ` +
        `${violations.join(', ')}`,
    ).toEqual([]);
  });

  it('the allow-listed files still exist (guards against a stale allow-list)', () => {
    const foundBasenames = new Set(files.map((f) => path.basename(f)));
    for (const allowed of ALLOWED_BASENAMES) {
      expect(foundBasenames.has(allowed), `expected to find allow-listed file '${allowed}'`).toBe(
        true,
      );
    }
  });
});
