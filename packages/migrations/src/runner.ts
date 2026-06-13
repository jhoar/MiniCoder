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

// Tables owned by MiniCoder — reset only drops these, never foreign tables.
// Order matters: EXPECTED_TABLES is in parent-first creation order; reversing
// gives children-first, allowing drops without CASCADE.
const OWNED_TABLES_DROP_ORDER = [...EXPECTED_TABLES].reverse();

// Environments where destructive operations are permitted.
const SAFE_ENVS = new Set(['development', 'test', 'ci']);

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const val = args[idx + 1];
  // A value starting with '--' is the next flag, not a value
  return val?.startsWith('--') ? undefined : val;
}

// Remove username and password from a PostgreSQL URL before logging.
function sanitizeDbIdentifier(identifier: string, dialect: Dialect): string {
  if (dialect !== 'postgres') return identifier;
  try {
    const u = new URL(identifier);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '(unparseable URL)';
  }
}

interface ResetContext {
  dialect: Dialect;
  dbIdentifier: string;
}

function auditAndGuardReset(args: string[], ctx: ResetContext): void {
  // 1a. System environment guard — deployment-level env vars cannot be overridden
  //     by the --env flag. If the process knows it is running in a non-safe
  //     environment, refuse regardless of what the caller supplies.
  const sysEnv = (process.env['APP_ENV'] ?? process.env['NODE_ENV'] ?? '').toLowerCase();
  if (sysEnv && !SAFE_ENVS.has(sysEnv)) {
    console.error(
      `  reset is blocked: deployment environment is "${sysEnv}" (APP_ENV/NODE_ENV).\n` +
        '  Reset is only permitted when APP_ENV/NODE_ENV is development, test, or ci.',
    );
    process.exit(1);
  }

  // 1b. Explicit --env flag required as a second, caller-supplied confirmation
  const envFlag = parseFlag(args, '--env');
  if (!envFlag) {
    console.error(
      '  reset requires --env <environment> (e.g. --env development).\n' +
        '  Permitted values: development, test, ci.',
    );
    process.exit(1);
  }
  const env = envFlag.toLowerCase();
  if (!SAFE_ENVS.has(env)) {
    console.error(
      `  reset is not permitted in environment "${env}".\n` +
        '  Permitted values: development, test, ci.',
    );
    process.exit(1);
  }

  // 2. Audit log — printed before any mutation so it is visible even if reset fails
  const ts = new Date().toISOString();
  const safeDb = sanitizeDbIdentifier(ctx.dbIdentifier, ctx.dialect);
  console.log('  ┌─ RESET AUDIT ──────────────────────────────────────────────');
  console.log(`  │  timestamp  : ${ts}`);
  console.log(`  │  env (flag) : ${env}`);
  console.log(`  │  env (sys)  : ${sysEnv || '(unset)'}`);
  console.log(`  │  dialect    : ${ctx.dialect}`);
  console.log(`  │  database   : ${safeDb}`);
  console.log(
    `  │  tables     : ${OWNED_TABLES_DROP_ORDER.length + 1} owned tables will be dropped`,
  );
  console.log('  │  roles      : no role system active in Phase 1 CLI mode');
  console.log('  │  backup     : WARNING — no backup has been verified');
  console.log('  └────────────────────────────────────────────────────────────');

  // 3. Dry-run summary so the operator can see what will be dropped
  console.log('\n  Tables to be dropped (reverse-dependency order):');
  for (const t of OWNED_TABLES_DROP_ORDER) {
    console.log(`    - ${t}`);
  }
  console.log('    - _migrations');
  console.log();
}

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
  // FK enforcement is temporarily disabled so tables can be dropped in
  // reverse-dependency order without needing CASCADE (which would silently
  // remove FK constraints on external tables sharing this file).
  db.pragma('foreign_keys = OFF');
  for (const table of OWNED_TABLES_DROP_ORDER) {
    db.exec(`DROP TABLE IF EXISTS "${table}"`);
  }
  db.exec('DROP TABLE IF EXISTS "_migrations"');
  db.pragma('foreign_keys = ON');
  console.log(`  Dropped ${OWNED_TABLES_DROP_ORDER.length + 1} owned tables.`);
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
    // Drop in children-first (reverse-dependency) order WITHOUT CASCADE so that
    // foreign-key constraints on external tables referencing owned tables are
    // never silently removed.
    for (const table of OWNED_TABLES_DROP_ORDER) {
      await client.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    await client.query('DROP TABLE IF EXISTS "_migrations"');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  console.log(`  Dropped ${OWNED_TABLES_DROP_ORDER.length + 1} owned tables.`);
}

// ============================================================
// Main CLI
// ============================================================

async function main(): Promise<void> {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  const dialect = getDialect();

  if (!command) {
    console.error(
      'Usage: runner.ts <migrate|rollback|status|validate|reset|seed> [--yes] [--env <environment>]',
    );
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
          console.error('  reset requires --yes and --env <environment> flags.');
          process.exit(1);
        }
        auditAndGuardReset(args, { dialect, dbIdentifier: dbPath });
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
            console.error('  reset requires --yes and --env <environment> flags.');
            process.exit(1);
          }
          auditAndGuardReset(args, { dialect, dbIdentifier: dbUrl });
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
