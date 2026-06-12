import { describe, it, expect } from 'vitest';
import { assertVersion, nextVersion } from './optimistic.js';
import { OptimisticLockError } from './types.js';

describe('assertVersion', () => {
  it('passes when versions match', () => {
    expect(() => assertVersion('projects', 'id-1', { version: 3 }, 3)).not.toThrow();
  });

  it('throws OptimisticLockError when versions differ', () => {
    expect(() => assertVersion('projects', 'id-1', { version: 2 }, 3)).toThrowError(
      OptimisticLockError,
    );
  });

  it('throws OptimisticLockError when row is null', () => {
    expect(() => assertVersion('projects', 'id-1', null, 1)).toThrowError(OptimisticLockError);
  });

  it('throws OptimisticLockError when row is undefined', () => {
    expect(() => assertVersion('projects', 'id-1', undefined, 1)).toThrowError(OptimisticLockError);
  });

  it('error message includes table and id', () => {
    try {
      assertVersion('feature_requests', 'FR-001', { version: 1 }, 5);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OptimisticLockError);
      const err = e as OptimisticLockError;
      expect(err.table).toBe('feature_requests');
      expect(err.id).toBe('FR-001');
      expect(err.expectedVersion).toBe(5);
      expect(err.actualVersion).toBe(1);
    }
  });
});

describe('nextVersion', () => {
  it('increments by 1', () => {
    expect(nextVersion(1)).toBe(2);
    expect(nextVersion(5)).toBe(6);
    expect(nextVersion(0)).toBe(1);
  });
});
