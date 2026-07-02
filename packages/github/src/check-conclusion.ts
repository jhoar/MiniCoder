/**
 * Shared GitHub Checks-API conclusion classifier (MEDIUM-1 / HIGH-4 code-review fix, round 5).
 *
 * `octokit-client.ts`'s `deriveCiStatus` and `normalize.ts`'s `check_run`/`check_suite` webhook
 * normalization each independently classified a completed check run's `conclusion` string, and
 * had drifted apart: `deriveCiStatus` (round-4 HIGH-4 fix) correctly treats `neutral`/`skipped`/
 * `stale` as non-blocking-but-passing and `startup_failure` as a genuine failure, while
 * `normalize.ts` was never updated to match — a check run completing with any of those four
 * conclusions normalized to `null` and was silently dropped (never persisted to `inbox_events`).
 * This module is the single source of truth both files import, eliminating the duplication and,
 * by construction, fixing the normalizer's dropped conclusions.
 */

/** Conclusions GitHub itself treats as a genuine check-run failure. */
export const FAILURE_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
]);

/** Completed-but-not-failing conclusions — GitHub does not treat these as failures. */
export const NON_BLOCKING_CONCLUSIONS = new Set(['neutral', 'skipped', 'stale']);

export type CheckConclusionClassification = 'passed' | 'failed' | 'unknown';

/**
 * Classifies a single Checks-API `conclusion` value. `'unknown'` covers `null` (still
 * pending/in-progress, no conclusion yet) and any conclusion string neither set above recognizes
 * — callers treat `'unknown'` as "no verdict yet", never as a passing or failing signal.
 */
export function classifyCheckConclusion(conclusion: string | null): CheckConclusionClassification {
  if (conclusion === null) return 'unknown';
  if (FAILURE_CONCLUSIONS.has(conclusion)) return 'failed';
  if (conclusion === 'success' || NON_BLOCKING_CONCLUSIONS.has(conclusion)) return 'passed';
  return 'unknown';
}
