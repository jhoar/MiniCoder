import { describe, it, expect } from 'vitest';
import { parseWindowDays } from './parse-window-days';

describe('parseWindowDays (PR #73 review fix, LOW-2)', () => {
  it('returns undefined for an unset value', () => {
    expect(parseWindowDays(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(parseWindowDays('')).toBeUndefined();
  });

  it('parses a valid positive integer', () => {
    expect(parseWindowDays('30')).toBe(30);
  });

  it('rejects zero', () => {
    expect(parseWindowDays('0')).toBeUndefined();
  });

  it('rejects a negative value', () => {
    expect(parseWindowDays('-5')).toBeUndefined();
  });

  it('rejects a decimal value', () => {
    expect(parseWindowDays('1.5')).toBeUndefined();
  });

  it('rejects non-numeric text', () => {
    expect(parseWindowDays('not-a-number')).toBeUndefined();
  });
});
