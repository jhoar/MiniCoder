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
// `task_queue.project_id` carries a REFERENCES projects(id) foreign key (unchanged from migration
// 0017's original shape), so every project id a test's payload uses must exist in `projects`
// first — seeded here once, covering every id used across this file's test cases.
const SEEDED_PROJECT_IDS = ['proj-1', 'p', 'proj-2'];

function createMigratedSqliteFile(): string {
  const filePath = path.join(os.tmpdir(), `task-trigger-client-test-${crypto.randomUUID()}.db`);
  const raw = new Database(filePath);
  raw.pragma('foreign_keys = ON');
  for (const file of listMigrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const withoutPragma = sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*/im, '');
    raw.exec(withoutPragma);
  }
  for (const projectId of SEEDED_PROJECT_IDS) {
    raw
      .prepare(`INSERT INTO projects (id, name) VALUES (?, ?)`)
      .run(projectId, `Test Project ${projectId}`);
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
  project_id: string;
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
    expect(rows[0]!.project_id).toBe('proj-1');
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

  // PR #75 round-2 review fix (HIGH-2): idempotency dedup is scoped to
  // (project_id, task_id, idempotency_key), not (task_id, idempotency_key) — reusing the same key
  // for the SAME task but a DIFFERENT project must enqueue a separate row, not silently return the
  // other project's unrelated run id.
  it('reusing the same idempotency key for the same task in a different project enqueues a separate row', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    const project1Run = await client.triggerRunCoder({
      projectId: 'proj-1',
      featureRunId: 'run-1',
      coderAdapterName: 'CodexCoderAdapter',
      correlationId: 'corr-1',
      idempotencyKey: 'cross-project-key',
    });
    const project2Run = await client.triggerRunCoder({
      projectId: 'proj-2',
      featureRunId: 'run-1',
      coderAdapterName: 'CodexCoderAdapter',
      correlationId: 'corr-1',
      idempotencyKey: 'cross-project-key',
    });

    expect(project2Run.triggerdevRunId).not.toBe(project1Run.triggerdevRunId);
    const rows = queryTaskQueue(dbPath);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.project_id).sort()).toEqual(['proj-1', 'proj-2']);
  });

  // PR #75 review fix (MEDIUM-1): idempotency dedup is scoped to (task_id, idempotency_key), not
  // idempotency_key alone — reusing the same key for a DIFFERENT task must enqueue a separate row,
  // not silently return the unrelated first task's run id.
  it('reusing the same idempotency key for a different task enqueues a separate row', async () => {
    dbPath = createMigratedSqliteFile();
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;
    const { resolveDefaultTaskTriggerClient } = await import('./default-task-trigger-client.js');
    const client = resolveDefaultTaskTriggerClient();

    const coderRun = await client.triggerRunCoder({
      projectId: 'proj-1',
      featureRunId: 'run-1',
      coderAdapterName: 'CodexCoderAdapter',
      correlationId: 'corr-1',
      idempotencyKey: 'shared-key',
    });
    const reviewRun = await client.triggerRunReview({
      projectId: 'proj-1',
      featureRunId: 'run-1',
      reviewerAdapterName: 'ClaudeReviewerAdapter',
      correlationId: 'corr-1',
      idempotencyKey: 'shared-key',
    });

    expect(reviewRun.triggerdevRunId).not.toBe(coderRun.triggerdevRunId);
    const rows = queryTaskQueue(dbPath);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.task_id).sort()).toEqual(['run-coder', 'run-review']);
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
    await client.triggerStartNextFeature({
      projectId: 'p',
      correlationId: 'c',
      idempotencyKey: 'k4',
    });

    const rows = queryTaskQueue(dbPath).sort((a, b) =>
      a.idempotency_key.localeCompare(b.idempotency_key),
    );
    expect(rows.map((r) => r.task_id)).toEqual([
      'run-review',
      'run-merge-gate',
      'run-design-doc',
      'start-next-feature',
    ]);
  });

  // Every task id this client triggers must stay a member of the canonical ALL_TASK_IDS list.
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
    await client.triggerStartNextFeature({
      projectId: 'p',
      correlationId: 'c',
      idempotencyKey: 'k4',
    });

    const usedTaskIds = queryTaskQueue(dbPath).map((r) => r.task_id);
    for (const taskId of usedTaskIds) {
      expect(ALL_TASK_IDS).toContain(taskId);
    }
  });
});
