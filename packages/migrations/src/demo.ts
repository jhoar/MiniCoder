#!/usr/bin/env tsx
/**
 * Phase 1 runnable demo scenario.
 *
 * Usage:
 *   DB_DIALECT=sqlite DB_PATH=/tmp/minicoder-demo.db tsx packages/migrations/src/demo.ts
 *
 * What it does:
 *   1. Applies the initial schema migration to a fresh SQLite database
 *   2. Validates all 43 expected tables are present
 *   3. Inserts a sample project row
 *   4. Reads it back and prints it
 *   5. Demonstrates transaction atomicity: a rolled-back insert leaves no rows behind
 *   6. Prints a success summary
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { EXPECTED_TABLES } from './index.js';

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');
const DB_PATH = process.env['DB_PATH'] ?? '/tmp/minicoder-demo.db';

function hr(): void {
  console.log('─'.repeat(60));
}

function step(n: number, msg: string): void {
  console.log(`\nStep ${n}: ${msg}`);
}

function listUpMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sqlite.sql') && !f.includes('.down.'))
    .sort();
}

function migrationName(filename: string): string {
  return filename.replace(/\.sqlite\.sql$/, '');
}

async function main(): Promise<void> {
  hr();
  console.log('MiniCoder — Phase 1 Demo');
  console.log(`DB path: ${DB_PATH}`);
  hr();

  // Clean slate
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Step 1: Apply migrations
  step(1, 'Applying migration 0001_initial_schema …');
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );

  for (const file of listUpMigrationFiles()) {
    const name = migrationName(file);
    if (applied.has(name)) {
      console.log(`  (already applied: ${name})`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const applyMigration = db.transaction(() => {
      const sqlWithoutPragma = sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*/im, '');
      db.exec(sqlWithoutPragma);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    });
    applyMigration();
    console.log(`  ✓ Applied: ${name}`);
  }

  // Step 2: Validate
  step(2, 'Validating all expected tables …');
  const existingTables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != '_migrations'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );
  const missing = EXPECTED_TABLES.filter((t) => !existingTables.has(t));
  if (missing.length > 0) {
    console.error(`  ✗ Missing tables: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`  ✓ All ${EXPECTED_TABLES.length} tables present`);

  // Step 3: Insert a sample project
  step(3, 'Inserting a sample project …');
  const projectId = 'demo-project-001';
  db.prepare('INSERT INTO projects (id, name, description) VALUES (?, ?, ?)').run(
    projectId,
    'MiniCoder Demo',
    'Phase 1 demonstration project',
  );
  console.log(`  ✓ Inserted project id=${projectId}`);

  // Step 4: Read it back
  step(4, 'Reading the project back …');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<
    string,
    unknown
  >;
  console.log(`  id          : ${String(project['id'])}`);
  console.log(`  name        : ${String(project['name'])}`);
  console.log(`  description : ${String(project['description'])}`);
  console.log(`  state       : ${String(project['state'])}`);
  console.log(`  version     : ${String(project['version'])}`);
  console.log(`  created_at  : ${String(project['created_at'])}`);

  // Step 5: Transaction atomicity (explicit BEGIN/COMMIT/ROLLBACK)
  step(5, 'Demonstrating transaction atomicity (ROLLBACK on error) …');
  const beforeCount = (db.prepare('SELECT COUNT(*) as n FROM projects').get() as { n: number }).n;

  db.exec('BEGIN');
  try {
    db.prepare("INSERT INTO projects (id, name) VALUES ('tx-demo', 'Transient')").run();
    throw new Error('simulated failure — this insert must be rolled back');
  } catch {
    db.exec('ROLLBACK');
  }

  const afterCount = (db.prepare('SELECT COUNT(*) as n FROM projects').get() as { n: number }).n;
  if (afterCount !== beforeCount) {
    console.error(
      `  ✗ Transaction was NOT rolled back (count went from ${beforeCount} to ${afterCount})`,
    );
    process.exit(1);
  }
  console.log(`  ✓ Row count unchanged after rolled-back transaction (${afterCount} project(s))`);

  db.close();

  // Summary
  console.log('');
  hr();
  console.log('\nPhase 1 Demo completed successfully.\n');
  console.log('  • Migration applied and validated');
  console.log(`  • All ${EXPECTED_TABLES.length} tables created`);
  console.log('  • Sample project inserted and read back');
  console.log('  • Transaction atomicity confirmed');
  console.log(`\nDatabase file: ${DB_PATH}`);
  hr();
}

main().catch((err: unknown) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
