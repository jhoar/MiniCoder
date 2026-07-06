import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresDbClient } from '@minicoder/persistence-postgres';
import {
  claimRouteIdempotencyKey,
  fulfillRouteIdempotencyKey,
  releaseRouteIdempotencyKey,
} from './route-idempotency.js';

/**
 * Issue #57: MINICODER_TEST_PG_URL-gated integration coverage for `route-idempotency.ts` against
 * a real PostgreSQL `idempotency_keys` table — `route-idempotency.test.ts`'s existing unit tests
 * mock `DbClient.query` to simulate the SQLite-string-vs-Postgres-object `result` column shape
 * difference, but never actually exercise a real JSONB column or real concurrent claimants. This
 * suite closes both gaps: a genuine claim → fulfill → reclaim round-trip through a live `result
 * JSONB` column, and a real concurrent-claim race (two `Promise.all`-driven claims for the same
 * key) resolving to exactly one `owned` outcome — following the same schema-per-suite pattern as
 * `runner.postgres.test.ts`/`registry.postgres.test.ts` and the Phase 8/orchestrator concurrency
 * suites in `packages/testing/src/*.postgres.test.ts`.
 *
 * Reverting `claimRouteIdempotencyKey`'s use of `parseJsonField()` back to a bare `JSON.parse()`
 * reproduces a real failure here: PostgreSQL's `pg` driver auto-parses a `JSONB` column into a JS
 * object, so `JSON.parse(alreadyAnObject)` throws `TypeError` — the round-trip test below fails
 * immediately with that error if the fix is reverted.
 */

const TEST_PG_URL = process.env['MINICODER_TEST_PG_URL'];
const RUN_PG = !!TEST_PG_URL;

const TEST_SCHEMA = 'minicoder_test_route_idempotency';
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations/migrations');

function listPgMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.postgres.sql') && !f.includes('.down.'))
    .sort();
}

async function applyAllMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (const file of listPgMigrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [
        file.replace(/\.postgres\.sql$/, ''),
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

describe.skipIf(!RUN_PG)('route-idempotency (PostgreSQL, issue #57)', () => {
  let pool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: TEST_PG_URL! });
    await adminPool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await adminPool.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await adminPool.end();

    const url = new URL(TEST_PG_URL!);
    url.searchParams.set('options', `-c search_path="${TEST_SCHEMA}"`);
    pool = new Pool({ connectionString: url.toString() });

    await applyAllMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
    const adminPool = new Pool({ connectionString: TEST_PG_URL! });
    await adminPool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await adminPool.end();
  });

  it('claim -> fulfill -> reclaim round-trips through a real JSONB result column', async () => {
    const client = await pool.connect();
    try {
      const db = new PostgresDbClient(client);
      const key = 'merge-if-ready:fr-001:v1';
      const scope = 'merge-if-ready-route';

      const claim = await claimRouteIdempotencyKey(db, key, scope, 60_000);
      expect(claim.outcome).toBe('owned');
      const claimId = (claim as { outcome: 'owned'; claimId: string }).claimId;

      const response = { status: 200, body: { merged: true, prNumber: 42 } };
      await fulfillRouteIdempotencyKey(db, claimId, response);

      // A later claim for the same key must replay the exact cached response, parsed correctly
      // from the real JSONB column (not double-encoded, not left as a raw string).
      const reclaim = await claimRouteIdempotencyKey(db, key, scope, 60_000);
      expect(reclaim).toEqual({ outcome: 'fulfilled', response });
    } finally {
      client.release();
    }
  });

  it('releasing an owned, unfulfilled claim lets a fresh retry claim ownership again', async () => {
    const client = await pool.connect();
    try {
      const db = new PostgresDbClient(client);
      const key = 'reconcile:proj-001:v3';
      const scope = 'reconcile-route';

      const claim = await claimRouteIdempotencyKey(db, key, scope, 60_000);
      expect(claim.outcome).toBe('owned');
      const claimId = (claim as { outcome: 'owned'; claimId: string }).claimId;

      await releaseRouteIdempotencyKey(db, claimId);

      const retry = await claimRouteIdempotencyKey(db, key, scope, 60_000);
      expect(retry.outcome).toBe('owned');
    } finally {
      client.release();
    }
  });

  it('a concurrent claim race for the same key resolves to exactly one owned outcome', async () => {
    const [clientA, clientB] = await Promise.all([pool.connect(), pool.connect()]);
    try {
      const dbA = new PostgresDbClient(clientA);
      const dbB = new PostgresDbClient(clientB);
      const key = 'merge-if-ready:fr-002:v1';
      const scope = 'merge-if-ready-route';

      const [resultA, resultB] = await Promise.all([
        claimRouteIdempotencyKey(dbA, key, scope, 60_000),
        claimRouteIdempotencyKey(dbB, key, scope, 60_000),
      ]);

      const outcomes = [resultA.outcome, resultB.outcome].sort();
      // Exactly one claimant owns the slot; the other must see it as already claimed
      // (in-progress, since neither has fulfilled yet) — never both "owned".
      expect(outcomes).toEqual(['in-progress', 'owned']);
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});
