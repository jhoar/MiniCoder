import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { EXPECTED_TABLES } from './index.js';

// Requires MINICODER_TEST_PG_URL — a dedicated test-only env var, deliberately
// distinct from DB_URL (used by the runner CLI) so production URLs are never
// passed accidentally. Tests run in an isolated schema that is dropped on exit.
const TEST_PG_URL = process.env['MINICODER_TEST_PG_URL'];
const RUN_PG = !!TEST_PG_URL;

// Fixed schema name: DROP + CREATE in beforeAll ensures a clean slate, and a
// fixed name avoids accumulating stale schemas from crashed runs.
const TEST_SCHEMA = 'minicoder_test';

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

function listPgMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.postgres.sql') && !f.includes('.down.'))
    .sort();
}

function migrationName(filename: string): string {
  return filename.replace(/\.postgres\.sql$/, '');
}

async function applyMigrations(pool: Pool): Promise<number> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name),
  );

  const files = listPgMigrationFiles();
  let count = 0;

  for (const file of files) {
    const name = migrationName(file);
    if (applied.has(name)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    count++;
  }

  return count;
}

async function rollbackLast(pool: Pool): Promise<string | null> {
  const result = await pool.query<{ name: string }>(
    'SELECT name FROM _migrations ORDER BY name DESC LIMIT 1',
  );
  if (result.rows.length === 0) return null;
  const last = result.rows[0]!.name;

  const downFile = `${last}.postgres.down.sql`;
  const downPath = path.join(MIGRATIONS_DIR, downFile);
  if (!fs.existsSync(downPath)) throw new Error(`Down migration not found: ${downPath}`);

  const sql = fs.readFileSync(downPath, 'utf-8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('DELETE FROM _migrations WHERE name = $1', [last]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return last;
}

async function getExistingTables(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename != '_migrations'`,
    [TEST_SCHEMA],
  );
  return result.rows.map((r) => r.tablename);
}

describe.skipIf(!RUN_PG)('Migration runner (PostgreSQL)', () => {
  let pool: Pool;

  beforeAll(async () => {
    // Create the isolated test schema (drop first to clean up any stale state
    // from a previous crashed run). All tables live inside this schema.
    const adminPool = new Pool({ connectionString: TEST_PG_URL! });
    await adminPool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await adminPool.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await adminPool.end();

    // Pin search_path for every connection in the pool via startup parameter.
    // This ensures all queries land in the isolated schema without any
    // schema-prefix boilerplate in SQL strings.
    const url = new URL(TEST_PG_URL!);
    url.searchParams.set('options', `-c search_path="${TEST_SCHEMA}"`);
    pool = new Pool({ connectionString: url.toString() });
  });

  afterAll(async () => {
    await pool.end();
    const adminPool = new Pool({ connectionString: TEST_PG_URL! });
    await adminPool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await adminPool.end();
  });

  it('applies 0001_initial_schema cleanly on a fresh database', async () => {
    const count = await applyMigrations(pool);
    expect(count).toBe(1);
  });

  it('is idempotent — re-applying makes no changes', async () => {
    const count = await applyMigrations(pool);
    expect(count).toBe(0);
  });

  it('creates all 43 expected tables', async () => {
    const tables = await getExistingTables(pool);
    const tableSet = new Set(tables);
    const missing = EXPECTED_TABLES.filter((t) => !tableSet.has(t));
    expect(missing, `Missing tables: ${missing.join(', ')}`).toEqual([]);
  });

  it('records the migration in _migrations', async () => {
    const result = await pool.query<{ name: string }>('SELECT name FROM _migrations');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.name).toBe('0001_initial_schema');
  });

  it('enforces FK (repositories must reference existing projects)', async () => {
    await expect(
      pool.query(
        "INSERT INTO repositories (id, project_id, owner, name, full_name) VALUES ('r1', 'nonexistent', 'o', 'n', 'o/n')",
      ),
    ).rejects.toThrow();
  });

  it('enforces UNIQUE constraint on dedup_key in inbox_events', async () => {
    await pool.query(
      "INSERT INTO inbox_events (id, dedup_key, event_type, payload, payload_schema_version) VALUES ('ie-pg-1', 'guid-001', 'push', '{}', '1.0.0')",
    );
    await expect(
      pool.query(
        "INSERT INTO inbox_events (id, dedup_key, event_type, payload, payload_schema_version) VALUES ('ie-pg-2', 'guid-001', 'push', '{}', '1.0.0')",
      ),
    ).rejects.toThrow();
  });

  it('rollback removes all tables and the migration record', async () => {
    const before = await getExistingTables(pool);
    expect(before.length).toBe(43);

    const rolled = await rollbackLast(pool);
    expect(rolled).toBe('0001_initial_schema');

    const after = await getExistingTables(pool);
    expect(after.length).toBe(0);

    const records = await pool.query('SELECT name FROM _migrations');
    expect(records.rows.length).toBe(0);
  });

  it('migrate → rollback → migrate is idempotent', async () => {
    const count = await applyMigrations(pool);
    expect(count).toBe(1);
    expect((await getExistingTables(pool)).length).toBe(43);
  });
});
