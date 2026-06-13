import { OptimisticLockError } from './types.js';

export interface VersionedRow {
  version: number;
}

/**
 * Validates that a row's version matches the expected version before a mutating command.
 * Throws OptimisticLockError if versions don't match, preventing lost-update anomalies.
 */
export function assertVersion(
  table: string,
  id: string,
  row: VersionedRow | null | undefined,
  expectedVersion: number,
): asserts row is VersionedRow {
  if (!row) {
    throw new OptimisticLockError(table, id, expectedVersion, -1);
  }
  if (row.version !== expectedVersion) {
    throw new OptimisticLockError(table, id, expectedVersion, row.version);
  }
}

/**
 * Returns the next version number for an optimistic-concurrency update.
 */
export function nextVersion(current: number): number {
  return current + 1;
}
