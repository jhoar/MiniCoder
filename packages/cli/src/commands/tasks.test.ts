import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { createTasksCommand } from './tasks.js';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations/migrations');

function createMigratedSqliteFile(): string {
  const filePath = path.join(os.tmpdir(), `tasks-cli-test-${crypto.randomUUID()}.db`);
  const raw = new Database(filePath);
  raw.pragma('foreign_keys = ON');
  for (const file of fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sqlite.sql') && !f.includes('.down.'))
    .sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    raw.exec(sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*/im, ''));
  }
  raw.close();
  return filePath;
}

function insertPendingTaskQueueRow(filePath: string, id: string): void {
  const raw = new Database(filePath);
  const now = new Date().toISOString();
  raw
    .prepare(
      `INSERT INTO task_queue (id, task_id, payload, idempotency_key, status, attempts, version, created_at, updated_at)
       VALUES (?, 'run-coder', '{}', ?, 'pending', 0, 1, ?, ?)`,
    )
    .run(id, `idem-${id}`, now, now);
  raw.close();
}

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createTasksCommand());
  return program;
}

describe('CLI tasks drain command', () => {
  let dbPath: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['DB_DIALECT'];
    delete process.env['DB_PATH'];
    if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    dbPath = undefined;
  });

  it('reports drained immediately when the queue is already empty', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await makeProgram().parseAsync(['node', 'minicoder', 'tasks', 'drain', '--timeout-ms', '2000']);
    expect(logSpy.mock.calls.map((c) => c[0]).join('\n')).toContain('queue empty');
  });

  it('times out and sets a nonzero exit code when a row keeps failing (never reports a false success)', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    // A minimal '{}' payload fails run-coder's real Zod schema, so this row fails and backs off
    // repeatedly rather than ever succeeding — isEmpty() must not count a 'failed'-but-still-
    // retryable row as drained just because it isn't 'pending'/'processing' at the instant of the
    // check.
    insertPendingTaskQueueRow(dbPath, 'tq-always-fails');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'tasks',
      'drain',
      '--timeout-ms',
      '200',
      '--poll-interval-ms',
      '50',
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/timed out/);
  });
});
