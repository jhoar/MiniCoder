import { describe, it, expect } from 'vitest';
import { meetsRole } from './role-rank';

describe('meetsRole', () => {
  it('allows an equal-rank role', () => {
    expect(meetsRole('operator', 'operator')).toBe(true);
  });

  it('allows a higher-rank role', () => {
    expect(meetsRole('admin', 'operator')).toBe(true);
  });

  it('rejects a lower-rank role', () => {
    expect(meetsRole('viewer', 'operator')).toBe(false);
  });

  it('treats an unrecognized role as below every requirement', () => {
    expect(meetsRole('bogus', 'viewer')).toBe(false);
  });

  it('every role meets the viewer floor', () => {
    for (const role of ['viewer', 'operator', 'approver', 'admin']) {
      expect(meetsRole(role, 'viewer')).toBe(true);
    }
  });
});
