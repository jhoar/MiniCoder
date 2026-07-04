import { CommandError, OptimisticLockError, StaleFenceError } from '@minicoder/core';
import { LockConflictError } from '@minicoder/workflow';

/**
 * Shared classifier for "another actor moved state under us" races that a scheduled/opportunistic
 * task should treat as a non-fatal, retry-next-tick condition rather than an uncaught task
 * failure — extracted from `start-next-feature.ts` (Phase 8) so `github-reconciliation.ts` and
 * `run-coder.ts` (Phase 9) share one implementation instead of three drifting copies (CLAUDE.md's
 * Reference Coder Adapter Operational Constraints).
 *
 * `LockConflictError`/`OptimisticLockError`/`StaleFenceError` are always transient regardless of
 * caller. Which `CommandError` `problem.type`s count as transient is caller-specific (e.g.
 * `start-next-feature.ts` also treats `feature-already-active`/`automation-paused`/
 * `unmet-dependencies`/`not-found` as expected, while `github-reconciliation.ts` only treats
 * `concurrent-command` that way) — callers pass their own set.
 */
export function isTransientRace(
  err: unknown,
  expectedCommandErrorTypes: ReadonlySet<string>,
): boolean {
  if (err instanceof LockConflictError) return true;
  if (err instanceof OptimisticLockError) return true;
  if (err instanceof StaleFenceError) return true;
  return err instanceof CommandError && expectedCommandErrorTypes.has(err.problem.type);
}
