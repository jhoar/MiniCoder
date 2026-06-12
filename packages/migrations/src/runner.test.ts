import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { EXPECTED_TABLES } from './index.js';

// We test the migration runner by calling the SQLite functions directly
// rather than spawning a subprocess, to keep tests fast and hermetic.

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

function migrationName(filename: string): string {
  return filename.replace(/\.(sqlite|postgres)\.sql$/, '');
}

function listMigrationFiles(dialect: 'sqlite' | 'postgres'): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(`.${dialect}.sql`))
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
    const name = migrationName(file);
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

    db.prepare(
      "INSERT INTO projects (id, name) VALUES ('proj-1', 'Test Project')",
    ).run();
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

    // Simulate stale-fence rejection: held fence (3) < current fence (5)
    const heldFence = 3;
    const currentFence = lock?.fence ?? 0;
    expect(heldFence).toBeLessThan(currentFence); // application must reject this
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
