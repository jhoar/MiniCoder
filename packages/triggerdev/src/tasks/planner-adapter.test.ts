import { describe, it, expect, afterEach } from 'vitest';
import { resolvePlannerTimeoutMs } from './planner-adapter.js';

describe('resolvePlannerTimeoutMs', () => {
  afterEach(() => {
    delete process.env['PLANNER_TIMEOUT_MS'];
  });

  it('defaults to 120000ms when unset', () => {
    expect(resolvePlannerTimeoutMs()).toBe(120_000);
  });

  it('honors a valid override', () => {
    process.env['PLANNER_TIMEOUT_MS'] = '60000';
    expect(resolvePlannerTimeoutMs()).toBe(60_000);
  });

  it.each(['not-a-number', 'NaN', 'Infinity', '-1', '0', '', '   '])(
    'falls back to the default for an invalid value (%s)',
    (value) => {
      process.env['PLANNER_TIMEOUT_MS'] = value;
      expect(resolvePlannerTimeoutMs()).toBe(120_000);
    },
  );
});
