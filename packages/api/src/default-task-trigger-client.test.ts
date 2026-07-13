import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations/migrations');

function listMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sqlite.sql') && !f.includes('.down.'))
    .sort();
}

/** Creates a fully-migrated, file-backed SQLite DB — a `:memory:` DB can't be shared across the
 * separate connections `enqueueTask()` (inside the module under test) and this test's assertions
 * each open via `createDbClientFromEnv()`'s own `DB_PATH`-driven connection. */
function createMigratedSqliteFile(): string {
  const filePath = path.join(os.tmpdir(), `task-trigger-client-test-${crypto.randomUUID()}.db`);
  const raw = new Database(filePath);
  raw.pragma('foreign_keys = ON');
  for (const file of listMigrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const withoutPragma = sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*/im, '');
    raw.exec(withoutPragma);
  }
  raw.close();
  return filePath;
}

interface TaskQueueRow {
  id: string;
  task_id: string;
  payload: string;
  idempotency_key: string;
  status: string;
}

function queryTaskQueue(filePath: string): TaskQueueRow[] {
  const raw = new Database(filePath);
  const rows = raw.prepare('SELECT * FROM task_queue').all() as TaskQueueRow[];
  raw.close();
  return rows;
}

describe('resolveDefaultTaskTriggerClient (Trigger.dev replacement)', () => {
  let dbPath: string | undefined;

  afterEach(() => {
    delete process.env['DB_DIALECT'];
    delete process.env['DB_PATH'];
    if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    dbPath = undefined;
  });

  it('enqueues a pending task_queue row and returns its id as triggerdevRunId', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    const payload = {
      projectId: 'proj-1',
      featureRunId: 'run-1',
      coderAdapterName: 'CodexCoderAdapter',
      correlationId: 'corr-1',
      idempotencyKey: 'idem-1',
    };
    const result = await client.triggerRunCoder(payload);

    expect(typeof result.triggerdevRunId).toBe('string');
    const rows = queryTaskQueue(dbPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(result.triggerdevRunId);
    expect(rows[0]!.task_id).toBe('run-coder');
    expect(rows[0]!.idempotency_key).toBe('idem-1');
    expect(rows[0]!.status).toBe('pending');
    expect(JSON.parse(rows[0]!.payload)).toEqual(payload);
  });

  it('a repeat call with the same idempotency key returns the same run id without a second insert', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    const payload = {
      projectId: 'proj-1',
      featureRunId: 'run-1',
      reviewerAdapterName: 'ClaudeReviewerAdapter',
      correlationId: 'corr-1',
      idempotencyKey: 'idem-repeat',
    };
    const first = await client.triggerRunReview(payload);
    const second = await client.triggerRunReview(payload);

    expect(second.triggerdevRunId).toBe(first.triggerdevRunId);
    expect(queryTaskQueue(dbPath)).toHaveLength(1);
  });

  it('triggers run-review/run-merge-gate/run-design-doc by their exact canonical task IDs', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    await client.triggerRunReview({
      projectId: 'p',
      featureRunId: 'f',
      reviewerAdapterName: 'ClaudeReviewerAdapter',
      correlationId: 'c',
      idempotencyKey: 'k1',
    });
    await client.triggerRunMergeGate({
      projectId: 'p',
      featureRunId: 'f',
      correlationId: 'c',
      idempotencyKey: 'k2',
    });
    await client.triggerRunDesignDoc({
      projectId: 'p',
      documentationAdapterName: 'ClaudeDocumentationAdapter',
      correlationId: 'c',
      idempotencyKey: 'k3',
    });

    const rows = queryTaskQueue(dbPath).sort((a, b) =>
      a.idempotency_key.localeCompare(b.idempotency_key),
    );
    expect(rows.map((r) => r.task_id)).toEqual(['run-review', 'run-merge-gate', 'run-design-doc']);
  });

  // The four task ids this client triggers must stay members of the canonical ALL_TASK_IDS list.
  it('only enqueues task ids that are members of the canonical ALL_TASK_IDS list', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    const { ALL_TASK_IDS } = await import('@minicoder/triggerdev');
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    await client.triggerRunCoder({
      projectId: 'p',
      featureRunId: 'f',
      coderAdapterName: 'CodexCoderAdapter',
      correlationId: 'c',
      idempotencyKey: 'k0',
    });
    await client.triggerRunReview({
      projectId: 'p',
      featureRunId: 'f',
      reviewerAdapterName: 'ClaudeReviewerAdapter',
      correlationId: 'c',
      idempotencyKey: 'k1',
    });
    await client.triggerRunMergeGate({
      projectId: 'p',
      featureRunId: 'f',
      correlationId: 'c',
      idempotencyKey: 'k2',
    });
    await client.triggerRunDesignDoc({
      projectId: 'p',
      documentationAdapterName: 'ClaudeDocumentationAdapter',
      correlationId: 'c',
      idempotencyKey: 'k3',
    });

    const usedTaskIds = queryTaskQueue(dbPath).map((r) => r.task_id);
    for (const taskId of usedTaskIds) {
      expect(ALL_TASK_IDS).toContain(taskId);
    }
  });
});
