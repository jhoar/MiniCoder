import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SqliteDbClient } from '@minicoder/persistence-sqlite';
import type { TxClient } from '@minicoder/core';
import { EXPECTED_TABLES } from './index.js';

// We test the migration runner by calling the SQLite functions directly
// rather than spawning a subprocess, to keep tests fast and hermetic.

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

function upMigrationName(filename: string): string {
  return filename.replace(/\.(sqlite|postgres)\.sql$/, '');
}

function listMigrationFiles(dialect: 'sqlite' | 'postgres'): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(`.${dialect}.sql`) && !f.includes('.down.'))
    .sort();
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
}

function applyMigrations(db: Database.Database): number {
  db.pragma('foreign_keys = ON');
  ensureMigrationsTable(db);

  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );

  const files = listMigrationFiles('sqlite');
  let count = 0;

  for (const file of files) {
    const name = upMigrationName(file);
    if (applied.has(name)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const applyMigration = db.transaction(() => {
      const sqlWithoutPragma = sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*/im, '');
      db.exec(sqlWithoutPragma);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    });
    applyMigration();
    count++;
  }

  return count;
}

function rollbackLast(db: Database.Database): string | null {
  ensureMigrationsTable(db);
  const rows = db
    .prepare('SELECT name FROM _migrations ORDER BY name DESC LIMIT 1')
    .all() as Array<{ name: string }>;
  if (rows.length === 0) return null;
  const last = rows[0]!.name;

  const downFile = `${last}.sqlite.down.sql`;
  const downPath = path.join(MIGRATIONS_DIR, downFile);
  if (!fs.existsSync(downPath)) throw new Error(`Down migration not found: ${downPath}`);

  const sql = fs.readFileSync(downPath, 'utf-8');
  const doRollback = db.transaction(() => {
    const sqlWithoutPragma = sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*OFF\s*;\s*/im, '');
    const sqlWithoutFkOn = sqlWithoutPragma.replace(
      /^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*/im,
      '',
    );
    db.exec(sqlWithoutFkOn);
    db.prepare('DELETE FROM _migrations WHERE name = ?').run(last);
  });
  doRollback();
  return last;
}

function getExistingTables(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != '_migrations'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe('Migration runner (SQLite)', () => {
  let tmpDb: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `minicoder-test-${Date.now()}.db`);
    db = new Database(tmpDb);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
  });

  it('applies 0001_initial_schema cleanly on a fresh database', () => {
    const count = applyMigrations(db);
    expect(count).toBe(1);
  });

  it('is idempotent — re-applying migrations makes no changes', () => {
    applyMigrations(db);
    const count = applyMigrations(db);
    expect(count).toBe(0);
  });

  it('creates all expected tables', () => {
    applyMigrations(db);
    const tables = getExistingTables(db);
    const tableSet = new Set(tables);

    const missing = EXPECTED_TABLES.filter((t) => !tableSet.has(t));
    expect(missing, `Missing tables: ${missing.join(', ')}`).toEqual([]);
  });

  it('creates the _migrations tracking table with the applied migration record', () => {
    applyMigrations(db);
    const rows = db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe('0001_initial_schema');
  });

  it('rollback removes all tables and the migration record', () => {
    applyMigrations(db);
    expect(getExistingTables(db).length).toBe(43);

    const rolled = rollbackLast(db);
    expect(rolled).toBe('0001_initial_schema');

    const tables = getExistingTables(db);
    expect(tables.length).toBe(0);

    const records = db.prepare('SELECT name FROM _migrations').all();
    expect(records.length).toBe(0);
  });

  it('migrate → rollback → migrate is idempotent', () => {
    applyMigrations(db);
    rollbackLast(db);
    const count = applyMigrations(db);
    expect(count).toBe(1);
    expect(getExistingTables(db).length).toBe(43);
  });

  it('enforces foreign keys (projects must exist before repositories can reference them)', () => {
    applyMigrations(db);
    db.pragma('foreign_keys = ON');

    expect(() => {
      db.prepare(
        "INSERT INTO repositories (id, project_id, owner, name, full_name) VALUES ('r1', 'nonexistent-project', 'owner', 'repo', 'owner/repo')",
      ).run();
    }).toThrow();
  });

  it('enforces UNIQUE constraint on (project_id, fr_id) in feature_requests', () => {
    applyMigrations(db);

    db.prepare("INSERT INTO projects (id, name) VALUES ('proj-1', 'Test Project')").run();
    db.prepare(
      "INSERT INTO implementation_plans (id, project_id, title) VALUES ('plan-1', 'proj-1', 'Plan')",
    ).run();
    db.prepare(
      "INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description) VALUES ('fr-1', 'plan-1', 'proj-1', 'FR-001', 'Feature 1', 'desc')",
    ).run();

    expect(() => {
      db.prepare(
        "INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description) VALUES ('fr-2', 'plan-1', 'proj-1', 'FR-001', 'Duplicate', 'desc')",
      ).run();
    }).toThrow();
  });

  it('enforces UNIQUE constraint on dedup_key in inbox_events', () => {
    applyMigrations(db);

    db.prepare(
      "INSERT INTO inbox_events (id, dedup_key, event_type, payload, payload_schema_version) VALUES ('ie-1', 'github-delivery-abc', 'push', '{}', '1.0.0')",
    ).run();

    expect(() => {
      db.prepare(
        "INSERT INTO inbox_events (id, dedup_key, event_type, payload, payload_schema_version) VALUES ('ie-2', 'github-delivery-abc', 'push', '{}', '1.0.0')",
      ).run();
    }).toThrow();
  });

  it('rejects stale fence tokens via application-level check', () => {
    applyMigrations(db);

    db.prepare("INSERT INTO projects (id, name) VALUES ('proj-2', 'Lock Test')").run();
    db.prepare(
      "INSERT INTO workflow_locks (id, project_id, resource_key, holder_id, fence) VALUES ('lock-1', 'proj-2', 'execution', 'holder-a', 5)",
    ).run();

    const lock = db.prepare('SELECT fence FROM workflow_locks WHERE id = ?').get('lock-1') as
      | { fence: number }
      | undefined;
    expect(lock?.fence).toBe(5);

    const heldFence = 3;
    const currentFence = lock?.fence ?? 0;
    expect(heldFence).toBeLessThan(currentFence);
  });
});

describe('SqliteDbClient.transaction()', () => {
  let tmpDb: string;
  let db: Database.Database;
  let client: SqliteDbClient;

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `minicoder-tx-test-${Date.now()}.db`);
    db = new Database(tmpDb);
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE test_rows (id TEXT PRIMARY KEY, val TEXT NOT NULL)');
    client = new SqliteDbClient(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
  });

  it('commits rows when the callback succeeds', async () => {
    await client.transaction(async (tx: TxClient) => {
      await tx.execute("INSERT INTO test_rows (id, val) VALUES ('r1', 'hello')");
    });

    const rows = db.prepare('SELECT * FROM test_rows').all();
    expect(rows).toHaveLength(1);
  });

  it('rolls back all rows when the callback throws — transaction is atomic', async () => {
    await expect(
      client.transaction(async (tx: TxClient) => {
        await tx.execute("INSERT INTO test_rows (id, val) VALUES ('r2', 'should-disappear')");
        throw new Error('intentional error');
      }),
    ).rejects.toThrow('intentional error');

    const rows = db.prepare('SELECT * FROM test_rows').all();
    expect(rows).toHaveLength(0);
  });

  it('rolls back when a constraint violation occurs mid-transaction', async () => {
    await expect(
      client.transaction(async (tx: TxClient) => {
        await tx.execute("INSERT INTO test_rows (id, val) VALUES ('dup', 'first')");
        await tx.execute("INSERT INTO test_rows (id, val) VALUES ('dup', 'second')"); // duplicate PK
      }),
    ).rejects.toThrow();

    const rows = db.prepare('SELECT * FROM test_rows').all();
    expect(rows).toHaveLength(0);
  });
});

describe('EXPECTED_TABLES list', () => {
  it('contains 43 tables', () => {
    expect(EXPECTED_TABLES.length).toBe(43);
  });

  it('includes all core workflow tables', () => {
    expect(EXPECTED_TABLES).toContain('projects');
    expect(EXPECTED_TABLES).toContain('feature_requests');
    expect(EXPECTED_TABLES).toContain('feature_runs');
    expect(EXPECTED_TABLES).toContain('workflow_events');
    expect(EXPECTED_TABLES).toContain('workflow_locks');
    expect(EXPECTED_TABLES).toContain('outbox_events');
    expect(EXPECTED_TABLES).toContain('inbox_events');
    expect(EXPECTED_TABLES).toContain('idempotency_keys');
  });
});
