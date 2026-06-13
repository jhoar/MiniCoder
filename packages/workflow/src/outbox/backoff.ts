/**
 * Deterministic exponential backoff (no jitter) for outbox/inbox retry scheduling.
 * Returns the number of milliseconds to wait before the next attempt.
 */
export function deterministicBackoff(attempt: number, baseMs: number, maxMs: number): number {
  if (attempt <= 0) return 0;
  return Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
}
