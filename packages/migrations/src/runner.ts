#!/usr/bin/env tsx
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
// Single source of truth for the expected table list: this used to be a second, hand-maintained
// copy that silently drifted out of sync with EXPECTED_TABLES here (it was missing every Phase 6
// clarification_* table) because `db validate`/`db migrate` logging imports this file, not
// index.ts directly. Importing from index.ts guarantees `minicoder db validate`'s printed count
// and drop-order list can never diverge from the canonical, unit-tested table list again.
import { EXPECTED_TABLES } from './index.js';

type Dialect = 'sqlite' | 'postgres';

interface MigrationRecord {
  name: string;
  applied_at: string;
}

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

// Tables owned by MiniCoder — reset only drops these, never foreign tables.
// Order matters: EXPECTED_TABLES is in parent-first creation order; reversing
// gives children-first, allowing drops without CASCADE.
const OWNED_TABLES_DROP_ORDER = [...EXPECTED_TABLES].reverse();

// Environments where destructive operations are permitted.
const SAFE_ENVS = new Set(['development', 'test', 'ci']);

// Reset-target confirmation-token lifecycle: a single-use, time-boxed token bound to the exact
// database target being reset, mirroring `minicoder state repair`'s dry-run/apply/--confirmation
// pattern (packages/cli/src/commands/state.ts). A caller must run --dry-run first (which performs
// no mutation) to obtain a token, then re-run with --apply --confirmation <token>.
const CONFIRMATION_TOKEN_TTL_MS = 5 * 60 * 1000;
const RESET_PENDING_DIR = path.join(os.homedir(), '.minicoder');
const RESET_PENDING_FILE = path.join(RESET_PENDING_DIR, 'pending-reset-token.json');

// Postgres hosts a reset is permitted against by default when MINICODER_ALLOWED_RESET_HOSTS is
// unset. Anything else requires the explicit, visible --force-host override.
const DEFAULT_ALLOWED_RESET_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isoNow(): string {
  return new Date().toISOString();
}

function ttlIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const val = args[idx + 1];
  // A value starting with '--' is the next flag, not a value
  return val?.startsWith('--') ? undefined : val;
}

// Reduce a PostgreSQL URL to protocol + hostname + port + pathname before logging or
// fingerprinting. Username, password, query string, and fragment are dropped entirely — any of
// those can carry secrets (query-string `password`/token params, SSL key paths, provider-specific
// credentials), not just the URL authority.
function sanitizeDbIdentifier(identifier: string, dialect: Dialect): string {
  if (dialect !== 'postgres') return identifier;
  try {
    const u = new URL(identifier);
    const portSuffix = u.port ? `:${u.port}` : '';
    return `postgresql://${u.hostname}${portSuffix}${u.pathname}`;
  } catch {
    return '(unparseable URL)';
  }
}

// A stable, non-sensitive fingerprint of the reset target, used to bind a confirmation token to
// the exact database it was issued for (a token issued while previewing one target must not be
// usable to apply a reset against a different one).
function fingerprintTarget(dialect: Dialect, identifier: string): string {
  if (dialect === 'sqlite') return `sqlite:${path.resolve(identifier)}`;
  return `postgres:${sanitizeDbIdentifier(identifier, dialect)}`;
}

// Verifies the reset target's identity for PostgreSQL (SQLite files are inherently local — see
// CLAUDE.md's "SQLite is never used over a network filesystem" locked decision, so hosted/shared
// PostgreSQL targets are the actual risk this guards against). Returns an error string, or null if
// the target is acceptable.
function checkDatabaseIdentity(
  dialect: Dialect,
  identifier: string,
  args: string[],
): string | null {
  if (dialect !== 'postgres') return null;
  let hostname: string;
  try {
    hostname = new URL(identifier).hostname.toLowerCase();
  } catch {
    return 'reset is blocked: DB_URL could not be parsed to verify target host identity.';
  }
  const configured = (process.env['MINICODER_ALLOWED_RESET_HOSTS'] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allowed = configured.length > 0 ? new Set(configured) : DEFAULT_ALLOWED_RESET_HOSTS;
  if (allowed.has(hostname)) return null;
  if (args.includes('--force-host')) return null;
  return (
    `reset is blocked: PostgreSQL host "${hostname}" is not in the allowed reset-target list ` +
    `(${[...allowed].join(', ')}). Set MINICODER_ALLOWED_RESET_HOSTS to allow it, or pass ` +
    '--force-host to explicitly override (visible in the audit log).'
  );
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

  // 1c. When the system environment is known, --env must agree with it exactly. A caller-supplied
  //     flag alone must never be able to reclassify a database running under a different
  //     deployment environment.
  if (sysEnv && sysEnv !== env) {
    console.error(
      `  reset is blocked: --env "${env}" does not match the deployment environment ` +
        `"${sysEnv}" (APP_ENV/NODE_ENV). The two must match exactly.`,
    );
    process.exit(1);
  }

  // 1d. An unset system environment cannot be inferred as safe — the caller must explicitly
  //     acknowledge this is a known disposable target.
  if (!sysEnv && !args.includes('--disposable-db')) {
    console.error(
      '  reset is blocked: APP_ENV/NODE_ENV is unset, so the deployment environment cannot be ' +
        'verified.\n' +
        '  Pass --disposable-db to confirm this is a known throwaway local/CI database ' +
        '(e.g. a temp SQLite file or an ephemeral test PostgreSQL instance).',
    );
    process.exit(1);
  }

  // 1e. Actor identity. Phase 1's CLI has no session/role system (see docs/07 — real
  //     hosted OAuth/SSO sessions are deferred future work), so this is a caller-declared
  //     identity recorded for audit purposes, not an authenticated principal — the strongest
  //     authorization this profile can offer today. Reset is refused without one.
  const actor = parseFlag(args, '--actor');
  if (!actor) {
    console.error(
      '  reset requires --actor <name> identifying who is authorizing this destructive action.',
    );
    process.exit(1);
  }

  // 1f. Backup evidence — a bare warning is not enforcement. Require either a verified backup or
  //     an explicit, logged exemption reason.
  const backupExempt = parseFlag(args, '--backup-exempt');
  const backupVerified = args.includes('--backup-verified');
  if (!backupVerified && !backupExempt) {
    console.error(
      '  reset requires backup evidence: pass --backup-verified (a backup was taken) or\n' +
        '  --backup-exempt "<reason>" (explicitly document why no backup is needed, e.g. a ' +
        'disposable test database).',
    );
    process.exit(1);
  }

  // 1g. Database target identity (PostgreSQL only).
  const identityError = checkDatabaseIdentity(ctx.dialect, ctx.dbIdentifier, args);
  if (identityError) {
    console.error(`  ${identityError}`);
    process.exit(1);
  }

  // 1h. Two-step confirmation, bound to this exact target: --dry-run previews and issues a
  //     single-use, time-boxed token; --apply requires that token and performs the mutation.
  //     This mirrors `minicoder state repair`'s dry-run/apply/--confirmation contract.
  const dryRun = args.includes('--dry-run');
  const applyFlag = args.includes('--apply');
  const target = fingerprintTarget(ctx.dialect, ctx.dbIdentifier);

  if (!dryRun && !applyFlag) {
    console.error(
      '  reset requires either --dry-run (preview and issue a confirmation token) or\n' +
        '  --apply --confirmation <token> (perform the reset after a --dry-run).',
    );
    process.exit(1);
  }

  if (applyFlag) {
    const confirmation = parseFlag(args, '--confirmation');
    if (!confirmation) {
      console.error('  reset --apply requires --confirmation <token> (run --dry-run first).');
      process.exit(1);
    }
    let pending: { token: string; expiresAt: string; target: string };
    try {
      pending = JSON.parse(fs.readFileSync(RESET_PENDING_FILE, 'utf-8')) as typeof pending;
    } catch {
      console.error(
        '  reset is blocked: no pending confirmation token found. Run --dry-run first.',
      );
      process.exit(1);
    }
    if (pending.token !== confirmation) {
      console.error('  reset is blocked: confirmation token does not match the issued token.');
      process.exit(1);
    }
    if (new Date(pending.expiresAt) <= new Date()) {
      console.error('  reset is blocked: confirmation token has expired. Run --dry-run again.');
      process.exit(1);
    }
    if (pending.target !== target) {
      console.error(
        '  reset is blocked: confirmation token was issued for a different database target.',
      );
      process.exit(1);
    }
    // Single-use: consume the token immediately so it cannot be replayed.
    fs.unlinkSync(RESET_PENDING_FILE);
  }

  // 2. Audit log — printed before any mutation so it is visible even if reset fails
  const ts = isoNow();
  const safeDb = sanitizeDbIdentifier(ctx.dbIdentifier, ctx.dialect);
  console.log('  ┌─ RESET AUDIT ──────────────────────────────────────────────');
  console.log(`  │  timestamp  : ${ts}`);
  console.log(`  │  mode       : ${dryRun ? 'dry-run (no mutation)' : 'apply'}`);
  console.log(`  │  env (flag) : ${env}`);
  console.log(`  │  env (sys)  : ${sysEnv || '(unset — --disposable-db acknowledged)'}`);
  console.log(`  │  dialect    : ${ctx.dialect}`);
  console.log(`  │  database   : ${safeDb}`);
  console.log(
    `  │  tables     : ${OWNED_TABLES_DROP_ORDER.length + 1} owned tables will be dropped`,
  );
  console.log(`  │  actor      : ${actor}`);
  console.log(
    `  │  backup     : ${backupVerified ? 'verified by operator' : `EXEMPT — ${backupExempt}`}`,
  );
  console.log('  └────────────────────────────────────────────────────────────');

  // 3. Dry-run summary so the operator can see what will be dropped
  console.log('\n  Tables to be dropped (reverse-dependency order):');
  for (const t of OWNED_TABLES_DROP_ORDER) {
    console.log(`    - ${t}`);
  }
  console.log('    - _migrations');
  console.log();

  if (dryRun) {
    const token = crypto.randomUUID();
    const expiresAt = ttlIso(CONFIRMATION_TOKEN_TTL_MS);
    fs.mkdirSync(RESET_PENDING_DIR, { recursive: true });
    fs.writeFileSync(RESET_PENDING_FILE, JSON.stringify({ token, expiresAt, target }), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    console.log('  Dry run only — no mutation performed.');
    console.log(`  Confirmation token: ${token} (expires ${expiresAt})`);
    console.log(
      '  To apply: rerun with the same flags plus --apply --confirmation ' + `${token}\n`,
    );
    process.exit(0);
  }
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

    // Run the reset guard BEFORE opening the database file so a blocked reset
    // never creates the file on disk.
    if (command === 'reset') {
      if (args.includes('--apply') && !args.includes('--yes')) {
        console.error('  reset --apply requires --yes.');
        process.exit(1);
      }
      auditAndGuardReset(args, { dialect, dbIdentifier: dbPath });
    }

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
        // Guard already ran above; proceed directly.
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
          if (args.includes('--apply') && !args.includes('--yes')) {
            console.error('  reset --apply requires --yes.');
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
