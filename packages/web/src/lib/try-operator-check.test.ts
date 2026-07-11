import { describe, it, expect } from 'vitest';
import { ApiError } from './api-client';
import { tryOperatorCheck } from './try-operator-check';

describe('tryOperatorCheck', () => {
  it('returns ok with the resolved data on success', async () => {
    const result = await tryOperatorCheck(async () => ({ healthy: true }));
    expect(result).toEqual({ kind: 'ok', data: { healthy: true } });
  });

  it('returns forbidden for a genuine 403 (insufficient role)', async () => {
    const result = await tryOperatorCheck(async () => {
      throw new ApiError(403, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'requires operator role or above',
      });
    });
    expect(result).toEqual({ kind: 'forbidden' });
  });

  it('returns a distinct error state for a non-403 failure (a real outage), not "forbidden"', async () => {
    const result = await tryOperatorCheck(async () => {
      throw new ApiError(500, {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'database unavailable',
      });
    });
    expect(result).toEqual({ kind: 'error', detail: 'database unavailable' });
  });

  it('returns an error state for a non-ApiError failure (e.g. a network error)', async () => {
    const result = await tryOperatorCheck(async () => {
      throw new Error('fetch failed');
    });
    expect(result).toEqual({ kind: 'error', detail: 'fetch failed' });
  });
});
