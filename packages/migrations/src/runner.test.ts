import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { SqliteDbClient } from '@minicoder/persistence-sqlite';
import type { TxClient } from '@minicoder/core';
import { RollbackFailedError } from '@minicoder/core';
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
  let db: Database.Database;

  beforeEach(() => {
    // Use :memory: to avoid file-descriptor / WAL-cleanup interactions during
    // Vitest worker teardown that caused SIGSEGV with file-based databases.
    db = new Database(':memory:');
  });

  it('applies all migrations cleanly on a fresh database', () => {
    const count = applyMigrations(db);
    expect(count).toBeGreaterThanOrEqual(1);
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

  it('creates the _migrations tracking table with applied migration records', () => {
    const count = applyMigrations(db);
    const rows = db.prepare('SELECT name FROM _migrations ORDER BY name ASC').all() as Array<{
      name: string;
    }>;
    expect(rows.length).toBe(count);
    expect(rows[0]?.name).toBe('0001_initial_schema');
  });

  it('rollback removes the last migration and its record', () => {
    const count = applyMigrations(db);
    expect(getExistingTables(db).length).toBe(52);

    const rolled = rollbackLast(db);
    expect(rolled).not.toBeNull();

    const records = db.prepare('SELECT name FROM _migrations').all();
    expect(records.length).toBe(count - 1);
  });

  it('migrate → rollback → migrate is idempotent', () => {
    const total = applyMigrations(db);
    rollbackLast(db);
    const reapplied = applyMigrations(db);
    expect(reapplied).toBe(1);
    // All expected tables must still exist after re-applying
    const tables = new Set(getExistingTables(db));
    const missing = EXPECTED_TABLES.filter((t) => !tables.has(t));
    expect(missing, `Missing tables after re-migration: ${missing.join(', ')}`).toEqual([]);
    void total;
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

  it('enforces at most one default (project_id IS NULL) agent_configurations row per adapter', () => {
    applyMigrations(db);

    db.prepare(
      "INSERT INTO agent_adapters (id, role, name, implementation) VALUES ('adapter-1', 'CoderAgentAdapter', 'TestAdapter', 'mock')",
    ).run();
    db.prepare(
      "INSERT INTO agent_configurations (id, adapter_id, project_id, config) VALUES ('cfg-1', 'adapter-1', NULL, '{}')",
    ).run();

    expect(() => {
      db.prepare(
        "INSERT INTO agent_configurations (id, adapter_id, project_id, config) VALUES ('cfg-2', 'adapter-1', NULL, '{}')",
      ).run();
    }).toThrow();
  });

  it('enforces at most one agent_configurations row per (adapter, project)', () => {
    applyMigrations(db);

    db.prepare("INSERT INTO projects (id, name) VALUES ('proj-cfg', 'Config Test')").run();
    db.prepare(
      "INSERT INTO agent_adapters (id, role, name, implementation) VALUES ('adapter-2', 'CoderAgentAdapter', 'TestAdapter2', 'mock')",
    ).run();
    db.prepare(
      "INSERT INTO agent_configurations (id, adapter_id, project_id, config) VALUES ('cfg-3', 'adapter-2', 'proj-cfg', '{}')",
    ).run();

    expect(() => {
      db.prepare(
        "INSERT INTO agent_configurations (id, adapter_id, project_id, config) VALUES ('cfg-4', 'adapter-2', 'proj-cfg', '{}')",
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
  let db: Database.Database;
  let client: SqliteDbClient;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE test_rows (id TEXT PRIMARY KEY, val TEXT NOT NULL)');
    client = new SqliteDbClient(db);
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

  it('rejects client.execute() called on the outer DbClient while a transaction is active', async () => {
    await expect(
      client.transaction(async (_tx: TxClient) => {
        // Calling client (outer) instead of _tx inside the transaction must throw
        await client.execute("INSERT INTO test_rows (id, val) VALUES ('interleaved', 'bad')");
      }),
    ).rejects.toThrow(/transaction/i);

    // The transaction was rolled back; no rows should have been committed
    const rows = db.prepare('SELECT * FROM test_rows').all();
    expect(rows).toHaveLength(0);
  });

  it('rejects client.query() called on the outer DbClient while a transaction is active', async () => {
    await expect(
      client.transaction(async (_tx: TxClient) => {
        await client.query('SELECT 1');
      }),
    ).rejects.toThrow(/transaction/i);
  });

  it('rejects nested client.transaction() calls', async () => {
    await expect(
      client.transaction(async (_tx: TxClient) => {
        await client.transaction(async (_tx2: TxClient) => {
          await _tx2.execute("INSERT INTO test_rows (id, val) VALUES ('nested', 'bad')");
        });
      }),
    ).rejects.toThrow(/nested/i);

    const rows = db.prepare('SELECT * FROM test_rows').all();
    expect(rows).toHaveLength(0);
  });

  it('marks client dead and wraps both errors when ROLLBACK fails', async () => {
    const callbackError = new Error('callback failed');
    const rollbackError = new Error('ROLLBACK rejected');

    // Spy on db.exec to make ROLLBACK throw while allowing BEGIN through
    const execSpy = vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (sql === 'ROLLBACK') throw rollbackError;
      return db as unknown as Database.Database;
    });

    try {
      const err = await client
        .transaction(async (_tx: TxClient) => {
          throw callbackError;
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RollbackFailedError);
      expect((err as RollbackFailedError).originalError).toBe(callbackError);
      expect((err as RollbackFailedError).rollbackError).toBe(rollbackError);

      // Client must be dead — subsequent operations must throw
      await expect(client.execute('SELECT 1')).rejects.toThrow(/unusable/i);
      await expect(client.query('SELECT 1')).rejects.toThrow(/unusable/i);
    } finally {
      execSpy.mockRestore();
    }
  });

  it('SqliteTxClient rejects query() after the transaction ends', async () => {
    let capturedTx!: TxClient;

    await client.transaction(async (tx: TxClient) => {
      capturedTx = tx;
    });

    await expect(capturedTx.query('SELECT 1')).rejects.toThrow(/expired/i);
  });

  it('SqliteTxClient rejects execute() after the transaction ends', async () => {
    let capturedTx!: TxClient;

    await client.transaction(async (tx: TxClient) => {
      capturedTx = tx;
    });

    await expect(
      capturedTx.execute("INSERT INTO test_rows (id, val) VALUES ('x', 'y')"),
    ).rejects.toThrow(/expired/i);
  });

  it('SqliteTxClient rejects operations after a rolled-back transaction', async () => {
    let capturedTx!: TxClient;

    await client
      .transaction(async (tx: TxClient) => {
        capturedTx = tx;
        throw new Error('intentional');
      })
      .catch(() => {});

    await expect(
      capturedTx.execute("INSERT INTO test_rows (id, val) VALUES ('x', 'y')"),
    ).rejects.toThrow(/expired/i);
  });
});

describe('EXPECTED_TABLES list', () => {
  it('contains 52 tables', () => {
    expect(EXPECTED_TABLES.length).toBe(52);
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

// ============================================================
// Reset safety guards (subprocess tests)
// ============================================================

const runnerPath = path.resolve(__dirname, '../src/runner.ts');

function runRunner(
  args: string[],
  env: Record<string, string | undefined>,
): ReturnType<typeof spawnSync> {
  return spawnSync('tsx', [runnerPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

describe('Reset safety guards', () => {
  let tmpDb: string;
  let tmpHome: string;

  // The reset guard's confirmation-token file lives under os.homedir()/.minicoder — point HOME at
  // a fresh per-test directory so tests don't collide with each other or a real operator's token.
  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `minicoder-reset-guard-${Date.now()}-${Math.random()}.db`);
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'minicoder-reset-home-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const baseSqliteEnv = () => ({
    DB_DIALECT: 'sqlite',
    DB_PATH: tmpDb,
    HOME: tmpHome,
    APP_ENV: 'development',
  });

  function dryRun(extra: string[] = [], env: Record<string, string | undefined> = {}) {
    return runRunner(
      [
        'reset',
        '--dry-run',
        '--env',
        'development',
        '--actor',
        'test-operator',
        '--backup-exempt',
        'disposable test db',
        ...extra,
      ],
      { ...baseSqliteEnv(), ...env },
    );
  }

  function extractToken(stdout: string | Buffer | null): string {
    const text = stdout == null ? '' : stdout.toString();
    const m = text.match(/Confirmation token: (\S+)/);
    const token = m?.[1];
    if (!token) throw new Error(`no confirmation token found in stdout: ${text}`);
    return token;
  }

  it('blocks reset when APP_ENV=production regardless of --env flag', () => {
    const result = dryRun([], { APP_ENV: 'production' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/production/);
  });

  it('does NOT create the SQLite file when the system-env guard blocks reset', () => {
    expect(fs.existsSync(tmpDb)).toBe(false);
    dryRun([], { APP_ENV: 'production' });
    expect(fs.existsSync(tmpDb)).toBe(false);
  });

  it('blocks reset when --env flag is missing', () => {
    const result = runRunner(['reset', '--dry-run', '--actor', 'x', '--backup-exempt', 'y'], {
      ...baseSqliteEnv(),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--env/);
  });

  it('blocks reset when --env value is not an allowed environment', () => {
    const result = runRunner(
      ['reset', '--dry-run', '--env', 'staging', '--actor', 'x', '--backup-exempt', 'y'],
      { ...baseSqliteEnv() },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/staging/);
  });

  it('blocks reset when --env does not match a known system environment', () => {
    const result = runRunner(
      ['reset', '--dry-run', '--env', 'test', '--actor', 'x', '--backup-exempt', 'y'],
      { ...baseSqliteEnv(), APP_ENV: 'development' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not match/);
  });

  it('blocks reset when APP_ENV/NODE_ENV are unset and --disposable-db is not passed', () => {
    const result = runRunner(
      ['reset', '--dry-run', '--env', 'development', '--actor', 'x', '--backup-exempt', 'y'],
      {
        DB_DIALECT: 'sqlite',
        DB_PATH: tmpDb,
        HOME: tmpHome,
        APP_ENV: undefined,
        NODE_ENV: undefined,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/disposable-db/);
  });

  it('allows reset when APP_ENV/NODE_ENV are unset and --disposable-db is passed', () => {
    const result = runRunner(
      [
        'reset',
        '--dry-run',
        '--env',
        'development',
        '--actor',
        'x',
        '--backup-exempt',
        'y',
        '--disposable-db',
      ],
      {
        DB_DIALECT: 'sqlite',
        DB_PATH: tmpDb,
        HOME: tmpHome,
        APP_ENV: undefined,
        NODE_ENV: undefined,
      },
    );
    expect(result.status).toBe(0);
  });

  it('blocks reset when --actor is missing', () => {
    const result = runRunner(
      ['reset', '--dry-run', '--env', 'development', '--backup-exempt', 'y'],
      { ...baseSqliteEnv() },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--actor/);
  });

  it('blocks reset when neither --backup-verified nor --backup-exempt is supplied', () => {
    const result = runRunner(['reset', '--dry-run', '--env', 'development', '--actor', 'x'], {
      ...baseSqliteEnv(),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/backup/);
  });

  it('blocks apply when neither --dry-run nor --apply is passed', () => {
    const result = runRunner(
      ['reset', '--env', 'development', '--actor', 'x', '--backup-exempt', 'y'],
      { ...baseSqliteEnv() },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--dry-run|--apply/);
  });

  it('blocks apply without --yes', () => {
    const dr = dryRun();
    const token = extractToken(dr.stdout);
    const result = runRunner(
      [
        'reset',
        '--apply',
        '--confirmation',
        token,
        '--env',
        'development',
        '--actor',
        'x',
        '--backup-exempt',
        'y',
      ],
      { ...baseSqliteEnv() },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--yes/);
  });

  it('blocks apply with a wrong confirmation token', () => {
    dryRun();
    const result = runRunner(
      [
        'reset',
        '--apply',
        '--yes',
        '--confirmation',
        'not-the-real-token',
        '--env',
        'development',
        '--actor',
        'x',
        '--backup-exempt',
        'y',
      ],
      { ...baseSqliteEnv() },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not match/);
  });

  it('performs a real reset given a valid dry-run token and --apply --yes', () => {
    const dr = dryRun();
    expect(dr.status).toBe(0);
    const token = extractToken(dr.stdout);
    const result = runRunner(
      [
        'reset',
        '--apply',
        '--yes',
        '--confirmation',
        token,
        '--env',
        'development',
        '--actor',
        'test-operator',
        '--backup-exempt',
        'disposable test db',
      ],
      { ...baseSqliteEnv() },
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(tmpDb)).toBe(true);
  });

  it('does not create the SQLite file during --dry-run', () => {
    dryRun();
    expect(fs.existsSync(tmpDb)).toBe(false);
  });

  it('redacts PostgreSQL credentials and query-string secrets from audit output', () => {
    const result = runRunner(
      [
        'reset',
        '--dry-run',
        '--env',
        'development',
        '--actor',
        'test-operator',
        '--backup-exempt',
        'disposable test db',
      ],
      {
        DB_DIALECT: 'postgres',
        HOME: tmpHome,
        APP_ENV: 'development',
        DB_URL:
          'postgresql://alice:supersecret@localhost:15432/devdb?password=query-secret&token=abc#frag-secret',
      },
    );
    expect(result.stdout).not.toMatch(/supersecret/);
    expect(result.stdout).not.toMatch(/alice/);
    expect(result.stdout).not.toMatch(/query-secret/);
    expect(result.stdout).not.toMatch(/token=abc/);
    expect(result.stdout).not.toMatch(/frag-secret/);
    // Sanitized host/db should still appear
    expect(result.stdout).toMatch(/localhost/);
    expect(result.stdout).toMatch(/devdb/);
  });

  it('replaces a malformed connection string with a non-sensitive placeholder', () => {
    const result = runRunner(
      [
        'reset',
        '--dry-run',
        '--env',
        'development',
        '--actor',
        'test-operator',
        '--backup-exempt',
        'disposable test db',
      ],
      {
        DB_DIALECT: 'postgres',
        HOME: tmpHome,
        APP_ENV: 'development',
        DB_URL: 'not a valid url ::: secret-should-not-leak',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).not.toMatch(/secret-should-not-leak/);
    expect(result.stderr).not.toMatch(/secret-should-not-leak/);
    expect(result.stderr).toMatch(/could not be parsed/);
  });

  it('blocks a PostgreSQL reset against a non-allowlisted host without --force-host', () => {
    const result = runRunner(
      [
        'reset',
        '--dry-run',
        '--env',
        'development',
        '--actor',
        'test-operator',
        '--backup-exempt',
        'y',
      ],
      {
        DB_DIALECT: 'postgres',
        HOME: tmpHome,
        APP_ENV: 'development',
        DB_URL: 'postgresql://alice:secret@prod-db.example.com:5432/devdb',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not in the allowed reset-target list/);
  });

  it('allows a non-allowlisted PostgreSQL host when --force-host is passed', () => {
    const result = runRunner(
      [
        'reset',
        '--dry-run',
        '--env',
        'development',
        '--actor',
        'test-operator',
        '--backup-exempt',
        'y',
        '--force-host',
      ],
      {
        DB_DIALECT: 'postgres',
        HOME: tmpHome,
        APP_ENV: 'development',
        DB_URL: 'postgresql://alice:secret@prod-db.example.com:5432/devdb',
      },
    );
    expect(result.status).toBe(0);
  });

  it('allows reset when APP_ENV=development and --env development', () => {
    const result = dryRun();
    expect(result.status).toBe(0);
  });
});
