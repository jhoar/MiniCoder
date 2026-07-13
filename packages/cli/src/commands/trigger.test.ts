import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { createTriggerCommand } from './trigger.js';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations/migrations');

function listMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sqlite.sql') && !f.includes('.down.'))
    .sort();
}

function createMigratedSqliteFile(): string {
  const filePath = path.join(os.tmpdir(), `trigger-cli-test-${crypto.randomUUID()}.db`);
  const raw = new Database(filePath);
  raw.pragma('foreign_keys = ON');
  for (const file of listMigrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    raw.exec(sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*/im, ''));
  }
  // task_queue.project_id carries a REFERENCES projects(id) foreign key — seed the one project id
  // every insertTaskQueueRow() call in this file uses.
  raw.prepare(`INSERT INTO projects (id, name) VALUES ('proj-1', 'Test Project')`).run();
  raw.close();
  return filePath;
}

function insertTaskQueueRow(
  filePath: string,
  id: string,
  taskId: string,
  opts: { status?: string; attempts?: number } = {},
): void {
  const raw = new Database(filePath);
  const now = new Date().toISOString();
  raw
    .prepare(
      `INSERT INTO task_queue (id, task_id, payload, idempotency_key, status, attempts, project_id, version, created_at, updated_at)
       VALUES (?, ?, '{"projectId":"proj-1"}', ?, ?, ?, 'proj-1', 1, ?, ?)`,
    )
    .run(id, taskId, `idem-${id}`, opts.status ?? 'pending', opts.attempts ?? 0, now, now);
  raw.close();
}

function queryTaskQueue(filePath: string): Array<Record<string, unknown>> {
  const raw = new Database(filePath);
  const rows = raw.prepare('SELECT * FROM task_queue').all();
  raw.close();
  return rows as Array<Record<string, unknown>>;
}

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createTriggerCommand());
  return program;
}

describe('CLI trigger command (Trigger.dev replacement)', () => {
  let dbPath: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['DB_DIALECT'];
    delete process.env['DB_PATH'];
    delete process.env['APP_ENV'];
    delete process.env['NODE_ENV'];
    if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    dbPath = undefined;
  });

  it('validate reports ok when every ALL_TASK_IDS entry is registered', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await makeProgram().parseAsync(['node', 'minicoder', 'trigger', 'validate']);
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('"status": "ok"');
    expect(printed).toContain('"taskCount": 19');
  });

  it('list-runs and inspect-run read from triggerdev_runs/task_queue', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    insertTaskQueueRow(dbPath, 'tq-1', 'run-coder');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await makeProgram().parseAsync(['node', 'minicoder', 'trigger', 'inspect-run', 'tq-1']);
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('"id": "tq-1"');
    expect(printed).toContain('"task_id": "run-coder"');
  });

  it('cancel-run force-fails a task_queue row so it is no longer retryable', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    insertTaskQueueRow(dbPath, 'tq-2', 'run-coder', { status: 'processing' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await makeProgram().parseAsync(['node', 'minicoder', 'trigger', 'cancel-run', 'tq-2']);
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('"cancelled": true');

    const row = queryTaskQueue(dbPath).find((r) => r.id === 'tq-2')!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1000000);
  });

  it('cancel-run reports not cancelled for a nonexistent run id', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'trigger',
      'cancel-run',
      'does-not-exist',
    ]);
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('"cancelled": false');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('replay-run re-enqueues the same task/payload with a fresh idempotency key', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    insertTaskQueueRow(dbPath, 'tq-3', 'run-review', { status: 'failed', attempts: 3 });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await makeProgram().parseAsync(['node', 'minicoder', 'trigger', 'replay-run', 'tq-3']);
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('"taskId": "run-review"');

    const rows = queryTaskQueue(dbPath);
    expect(rows).toHaveLength(2);
    const replayed = rows.find((r) => r.id !== 'tq-3')!;
    expect(replayed.task_id).toBe('run-review');
    expect(replayed.status).toBe('pending');
    expect(replayed.attempts).toBe(0);
  });

  // PR #75 round-2 review fix (MEDIUM-1): the original replay INSERT omitted project_id
  // entirely, silently dropping project-scoping metadata from the replayed row.
  it('replay-run preserves the source row project_id', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    insertTaskQueueRow(dbPath, 'tq-3b', 'run-review', { status: 'failed', attempts: 3 });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await makeProgram().parseAsync(['node', 'minicoder', 'trigger', 'replay-run', 'tq-3b']);

    const rows = queryTaskQueue(dbPath);
    const replayed = rows.find((r) => r.id !== 'tq-3b')!;
    expect(replayed.project_id).toBe('proj-1');
  });

  it('reset-dev refuses without --yes/--env, and clears task_queue when guarded correctly', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    process.env['APP_ENV'] = 'test';
    insertTaskQueueRow(dbPath, 'tq-4', 'run-coder');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await makeProgram().parseAsync(['node', 'minicoder', 'trigger', 'reset-dev']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/--yes/);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'trigger',
      'reset-dev',
      '--yes',
      '--env',
      'test',
    ]);
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('"deleted": 1');
    expect(queryTaskQueue(dbPath)).toHaveLength(0);
  });

  // PR #75 review fix (HIGH-3): unset APP_ENV/NODE_ENV must never be inferred as safe, since this
  // command performs a real DELETE FROM task_queue.
  it('reset-dev blocks when APP_ENV/NODE_ENV are both unset, even with --env test', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    insertTaskQueueRow(dbPath, 'tq-unset-env', 'run-coder');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'trigger',
      'reset-dev',
      '--yes',
      '--env',
      'test',
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/not safe/);
    expect(queryTaskQueue(dbPath)).toHaveLength(1);
  });

  it('reset-dev blocks when APP_ENV is production, even with --env test', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    process.env['APP_ENV'] = 'production';

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'trigger',
      'reset-dev',
      '--yes',
      '--env',
      'test',
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/not safe/);
  });

  // PR #75 round-2 review fix (MEDIUM-2): APP_ENV=development and --env test are each
  // individually in the safe set, but disagree about which environment this actually is — a
  // caller-supplied --env flag alone must never be able to reclassify a database running under a
  // different deployment environment.
  it('reset-dev blocks when --env does not match a set, individually-safe system env', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    process.env['APP_ENV'] = 'development';
    insertTaskQueueRow(dbPath, 'tq-mismatch', 'run-coder');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'trigger',
      'reset-dev',
      '--yes',
      '--env',
      'test',
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/does not match the deployment environment/);
    expect(queryTaskQueue(dbPath)).toHaveLength(1);
  });

  it('reconcile flags a task_queue row with no linked triggerdev_runs row', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    insertTaskQueueRow(dbPath, 'tq-5', 'run-coder', { status: 'succeeded' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await makeProgram().parseAsync(['node', 'minicoder', 'trigger', 'reconcile']);
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('"driftDetected": true');
    expect(printed).toContain('"id": "tq-5"');
  });
});
