import { describe, it, expect, vi } from 'vitest';
import type { DbClient } from '@minicoder/core';
import { claimRouteIdempotencyKey } from './route-idempotency.js';

/**
 * `idempotency_keys.result` is TEXT (a JSON string) in SQLite but JSONB in PostgreSQL — the `pg`
 * driver auto-parses JSON/JSONB columns into JS objects, so a fulfilled row's `result` comes back
 * as an already-parsed object on Postgres, not a string. A real cross-dialect integration test
 * would need a live Postgres connection (gated on `MINICODER_TEST_PG_URL` like this repo's other
 * Postgres-only suites); this unit test instead mocks `DbClient.query` to return exactly the shape
 * the `pg` driver produces, proving `claimRouteIdempotencyKey` doesn't blindly `JSON.parse` an
 * already-parsed object (which throws) — the bug this test guards against.
 */
function mockDbReturningResult(result: unknown): DbClient {
  return {
    query: vi.fn().mockResolvedValue([{ result }]),
    execute: vi.fn().mockResolvedValue(undefined),
    executeAffected: vi.fn().mockResolvedValue(0), // simulate a conflict: another row already claimed it
    transaction: vi.fn(),
    close: vi.fn(),
  } as unknown as DbClient;
}

describe('claimRouteIdempotencyKey', () => {
  it('handles a SQLite-shaped (string) fulfilled result', async () => {
    const db = mockDbReturningResult(JSON.stringify({ status: 200, body: { merged: true } }));
    const result = await claimRouteIdempotencyKey(db, 'key-1', 'scope-1', 60_000);
    expect(result).toEqual({
      outcome: 'fulfilled',
      response: { status: 200, body: { merged: true } },
    });
  });

  it('handles a Postgres-shaped (already-parsed object) fulfilled result without throwing', async () => {
    const db = mockDbReturningResult({ status: 200, body: { merged: true } });
    const result = await claimRouteIdempotencyKey(db, 'key-1', 'scope-1', 60_000);
    expect(result).toEqual({
      outcome: 'fulfilled',
      response: { status: 200, body: { merged: true } },
    });
  });
});
