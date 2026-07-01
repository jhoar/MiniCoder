import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { PostgresDbClient } from '@minicoder/persistence-postgres';
import { AdapterRegistry } from '@minicoder/core';

// Requires MINICODER_TEST_PG_URL — see runner.postgres.test.ts for rationale. This suite
// specifically guards against the PostgreSQL transaction-abort regression in
// AdapterRegistry.register: a raw INSERT that hits a unique-constraint violation aborts the
// enclosing transaction, so any code path that catches 23505 and re-queries inside the same
// transaction fails with "current transaction is aborted". register() must instead use
// INSERT ... ON CONFLICT DO NOTHING, which never errors.
const TEST_PG_URL = process.env['MINICODER_TEST_PG_URL'];
const RUN_PG = !!TEST_PG_URL;

const TEST_SCHEMA = 'minicoder_test_registry';
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

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

describe.skipIf(!RUN_PG)('AdapterRegistry (PostgreSQL)', () => {
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

  it('registers twice for the same (role, name): same id, incremented version, replaced capabilities, transaction stays usable', async () => {
    const client = await pool.connect();
    try {
      const db = new PostgresDbClient(client);
      const registry = new AdapterRegistry(db);

      const firstId = await registry.register({
        role: 'CoderAgentAdapter',
        name: 'PgConcurrencyAdapter',
        implementation: 'v1',
        capabilities: ['can_modify_files'],
      });

      // Second registration exercises the ON CONFLICT DO NOTHING path that previously
      // relied on catching 23505 inside the same transaction (which PostgreSQL aborts).
      const secondId = await registry.register({
        role: 'CoderAgentAdapter',
        name: 'PgConcurrencyAdapter',
        implementation: 'v2',
        capabilities: ['can_modify_files', 'can_commit'],
      });

      expect(secondId).toBe(firstId);

      const record = await registry.getById(firstId);
      expect(record.implementation).toBe('v2');
      expect(record.version).toBe(2);
      expect(record.capabilities).toEqual(['can_modify_files', 'can_commit']);

      // The connection/transaction must still be usable — this is exactly what failed
      // under the old catch-23505-and-requery-in-same-transaction implementation.
      const probe = await db.query<{ ok: number }>('SELECT 1 AS ok', []);
      expect(probe[0]?.ok).toBe(1);
    } finally {
      client.release();
    }
  });
});
