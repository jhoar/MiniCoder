#!/usr/bin/env tsx
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { Pool } from 'pg';

type Dialect = 'sqlite' | 'postgres';

interface MigrationRecord {
  name: string;
  applied_at: string;
}

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

// All tables created by the initial schema — used by validate command
const EXPECTED_TABLES = [
  'projects',
  'repositories',
  'github_links',
  'specification_inputs',
  'planning_readiness_assessments',
  'planning_gaps',
  'planning_questions',
  'planning_assumptions',
  'implementation_plans',
  'plan_sections',
  'feature_requests',
  'feature_dependencies',
  'acceptance_criteria',
  'test_expectations',
  'workflow_states',
  'feature_runs',
  'workflow_events',
  'workflow_locks',
  'idempotency_keys',
  'outbox_events',
  'inbox_events',
  'human_approvals',
  'policy_decisions',
  'agent_adapters',
  'agent_capabilities',
  'agent_configurations',
  'agent_runs',
  'agent_errors',
  'agent_tool_operations',
  'agent_context_packs',
  'adapter_conformance_results',
  'review_findings',
  'coder_responses',
  'disagreement_records',
  'budget_policies',
  'cost_records',
  'artifact_exports',
  'design_documents',
  'design_document_sections',
  'design_decisions',
  'glossary_terms',
  'triggerdev_runs',
  'merge_gate_evaluations',
];

function getDialect(): Dialect {
  const env = process.env['DB_DIALECT'];
  if (env === 'postgres' || env === 'sqlite') return env;
  return 'sqlite';
}

function getSqlitePath(): string {
  return process.env['DB_PATH'] ?? './minicoder.db';
}

function getPostgresUrl(): string {
  const url = process.env['DB_URL'];
  if (!url) throw new Error('DB_URL environment variable is required for PostgreSQL dialect');
  return url;
}

function listMigrationFiles(dialect: Dialect): string[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(`.${dialect}.sql`))
    .sort();
  return files;
}

function migrationName(filename: string): string {
  // e.g. "0001_initial_schema.sqlite.sql" → "0001_initial_schema"
  return filename.replace(/\.(sqlite|postgres)\.sql$/, '');
}

// ============================================================
// SQLite implementation
// ============================================================

function sqliteEnsureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
}

function sqliteGetApplied(db: Database.Database): Set<string> {
  const rows = db.prepare('SELECT name FROM _migrations').all() as MigrationRecord[];
  return new Set(rows.map((r) => r.name));
}

function sqliteMigrate(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  sqliteEnsureMigrationsTable(db);
  const applied = sqliteGetApplied(db);
  const files = listMigrationFiles('sqlite');

  let count = 0;
  for (const file of files) {
    const name = migrationName(file);
    if (applied.has(name)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const applyMigration = db.transaction(() => {
      // Remove the PRAGMA from individual migration files as it's set above
      const sqlWithoutPragma = sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*/im, '');
      db.exec(sqlWithoutPragma);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    });
    applyMigration();
    console.log(`  Applied: ${name}`);
    count++;
  }

  if (count === 0) {
    console.log('  No pending migrations.');
  } else {
    console.log(`  ${count} migration(s) applied.`);
  }
}

function sqliteRollback(db: Database.Database): void {
  sqliteEnsureMigrationsTable(db);
  const applied = sqliteGetApplied(db);
  if (applied.size === 0) {
    console.log('  Nothing to roll back.');
    return;
  }
  const last = Array.from(applied).sort().pop()!;
  console.log(`  Rolling back: ${last}`);
  const downFile = `${last}.sqlite.down.sql`;
  const downPath = path.join(MIGRATIONS_DIR, downFile);
  if (!fs.existsSync(downPath)) {
    console.error(`  No down migration found: ${downPath}`);
    process.exit(1);
  }
  const sql = fs.readFileSync(downPath, 'utf-8');
  const rollback = db.transaction(() => {
    db.exec(sql);
    db.prepare('DELETE FROM _migrations WHERE name = ?').run(last);
  });
  rollback();
  console.log(`  Rolled back: ${last}`);
}

function sqliteStatus(db: Database.Database): void {
  sqliteEnsureMigrationsTable(db);
  const applied = sqliteGetApplied(db);
  const files = listMigrationFiles('sqlite');

  console.log('\n  Migration Status (SQLite):');
  console.log('  ' + '-'.repeat(50));
  for (const file of files) {
    const name = migrationName(file);
    const status = applied.has(name) ? '✓ applied' : '○ pending';
    console.log(`  ${status}  ${name}`);
  }
  console.log();
}

function sqliteValidate(db: Database.Database): boolean {
  const existingTables = new Set(
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_migrations'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );

  const missing: string[] = [];
  for (const table of EXPECTED_TABLES) {
    if (!existingTables.has(table)) missing.push(table);
  }

  if (missing.length > 0) {
    console.error(`  Validation FAILED. Missing tables: ${missing.join(', ')}`);
    return false;
  }
  console.log(`  Validation PASSED. All ${EXPECTED_TABLES.length} tables present.`);
  return true;
}

function sqliteReset(db: Database.Database): void {
  db.pragma('foreign_keys = OFF');
  // Drop all user tables and the migrations table
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map((r) => r.name);
  for (const table of tables) {
    db.exec(`DROP TABLE IF EXISTS "${table}"`);
  }
  db.pragma('foreign_keys = ON');
  console.log('  Database reset complete.');
}

// ============================================================
// PostgreSQL implementation
// ============================================================

async function pgEnsureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function pgGetApplied(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<MigrationRecord>('SELECT name FROM _migrations');
  return new Set(result.rows.map((r) => r.name));
}

async function pgMigrate(pool: Pool): Promise<void> {
  await pgEnsureMigrationsTable(pool);
  const applied = await pgGetApplied(pool);
  const files = listMigrationFiles('postgres');

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
    console.log(`  Applied: ${name}`);
    count++;
  }

  if (count === 0) {
    console.log('  No pending migrations.');
  } else {
    console.log(`  ${count} migration(s) applied.`);
  }
}

async function pgRollback(pool: Pool): Promise<void> {
  await pgEnsureMigrationsTable(pool);
  const applied = await pgGetApplied(pool);
  if (applied.size === 0) {
    console.log('  Nothing to roll back.');
    return;
  }
  const last = Array.from(applied).sort().pop()!;
  const downFile = `${last}.postgres.down.sql`;
  const downPath = path.join(MIGRATIONS_DIR, downFile);
  if (!fs.existsSync(downPath)) {
    console.error(`  No down migration found: ${downPath}`);
    process.exit(1);
  }
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
  console.log(`  Rolled back: ${last}`);
}

async function pgStatus(pool: Pool): Promise<void> {
  await pgEnsureMigrationsTable(pool);
  const applied = await pgGetApplied(pool);
  const files = listMigrationFiles('postgres');

  console.log('\n  Migration Status (PostgreSQL):');
  console.log('  ' + '-'.repeat(50));
  for (const file of files) {
    const name = migrationName(file);
    const status = applied.has(name) ? '✓ applied' : '○ pending';
    console.log(`  ${status}  ${name}`);
  }
  console.log();
}

async function pgValidate(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '_migrations'",
  );
  const existingTables = new Set(result.rows.map((r) => r.tablename));

  const missing: string[] = [];
  for (const table of EXPECTED_TABLES) {
    if (!existingTables.has(table)) missing.push(table);
  }

  if (missing.length > 0) {
    console.error(`  Validation FAILED. Missing tables: ${missing.join(', ')}`);
    return false;
  }
  console.log(`  Validation PASSED. All ${EXPECTED_TABLES.length} tables present.`);
  return true;
}

async function pgReset(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Drop all tables in the public schema
    const result = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    for (const row of result.rows) {
      await client.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  console.log('  Database reset complete.');
}

// ============================================================
// Main CLI
// ============================================================

async function main(): Promise<void> {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  const dialect = getDialect();

  if (!command) {
    console.error('Usage: runner.ts <migrate|rollback|status|validate|reset|seed> [--yes]');
    process.exit(1);
  }

  console.log(`\nMiniCoder DB Runner — dialect: ${dialect}\n`);

  if (dialect === 'sqlite') {
    const dbPath = getSqlitePath();
    const db = new Database(dbPath);

    switch (command) {
      case 'migrate':
        sqliteMigrate(db);
        break;
      case 'rollback':
        sqliteRollback(db);
        break;
      case 'status':
        sqliteStatus(db);
        break;
      case 'validate':
        if (!sqliteValidate(db)) process.exit(1);
        break;
      case 'reset':
        if (!args.includes('--yes')) {
          console.error('  reset requires --yes flag to confirm destructive operation.');
          process.exit(1);
        }
        sqliteReset(db);
        sqliteMigrate(db);
        break;
      case 'seed':
        console.log('  Seed: no seed data defined for Phase 1.');
        break;
      default:
        console.error(`  Unknown command: ${command}`);
        process.exit(1);
    }

    db.close();
  } else {
    const dbUrl = getPostgresUrl();
    const pool = new Pool({ connectionString: dbUrl });

    try {
      switch (command) {
        case 'migrate':
          await pgMigrate(pool);
          break;
        case 'rollback':
          await pgRollback(pool);
          break;
        case 'status':
          await pgStatus(pool);
          break;
        case 'validate':
          if (!(await pgValidate(pool))) process.exit(1);
          break;
        case 'reset':
          if (!args.includes('--yes')) {
            console.error('  reset requires --yes flag to confirm destructive operation.');
            process.exit(1);
          }
          await pgReset(pool);
          await pgMigrate(pool);
          break;
        case 'seed':
          console.log('  Seed: no seed data defined for Phase 1.');
          break;
        default:
          console.error(`  Unknown command: ${command}`);
          process.exit(1);
      }
    } finally {
      await pool.end();
    }
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
