import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SqliteDbClient } from '@minicoder/persistence-sqlite';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations/migrations');

function listMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sqlite.sql') && !f.includes('.down.'))
    .sort();
}

export function createTestDb(): SqliteDbClient {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');

  raw.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);

  const applied = new Set(
    (raw.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );

  for (const file of listMigrationFiles()) {
    const name = file.replace(/\.sqlite\.sql$/, '');
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const apply = raw.transaction(() => {
      const withoutPragma = sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*/im, '');
      raw.exec(withoutPragma);
      raw.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    });
    apply();
  }

  return new SqliteDbClient(raw);
}

export function insertTestProject(db: Database.Database, projectId = 'proj-1'): void {
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
  ).run(projectId);
}
