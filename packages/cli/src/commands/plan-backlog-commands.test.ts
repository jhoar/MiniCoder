import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { createPlanCommand } from './plan.js';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations/migrations');

function listMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sqlite.sql') && !f.includes('.down.'))
    .sort();
}

/** Seeds a project + one implementation_plans row + one valid (has acceptance criteria and test
 * expectations) feature_requests row — the minimum `ValidateBacklogHandler` needs for a `valid`
 * outcome (issue #104). */
function createMigratedSqliteFileWithValidBacklog(): { filePath: string; planId: string } {
  const filePath = path.join(os.tmpdir(), `plan-cli-test-${crypto.randomUUID()}.db`);
  const raw = new Database(filePath);
  raw.pragma('foreign_keys = ON');
  for (const file of listMigrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    raw.exec(sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*;\s*/im, ''));
  }
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO projects (id, name) VALUES ('proj-backlog-1', 'Test Project')`).run();
  const planId = 'plan-backlog-1';
  raw
    .prepare(
      `INSERT INTO implementation_plans (id, project_id, state, title, backlog_version, version, created_at, updated_at)
       VALUES (?, 'proj-backlog-1', 'activated_for_execution', 'Plan', 1, 1, ?, ?)`,
    )
    .run(planId, now, now);
  raw
    .prepare(
      `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES ('fr-backlog-1', ?, 'proj-backlog-1', 'FR-001', 'T', 'D', 'feature', 1, 'approved_pending_execution', 0, 1, ?, ?)`,
    )
    .run(planId, now, now);
  raw
    .prepare(
      `INSERT INTO acceptance_criteria (id, feature_request_id, description, order_index, version, created_at, updated_at)
       VALUES ('ac-backlog-1', 'fr-backlog-1', 'Criteria.', 0, 1, ?, ?)`,
    )
    .run(now, now);
  raw
    .prepare(
      `INSERT INTO test_expectations (id, feature_request_id, description, test_type, order_index, version, created_at, updated_at)
       VALUES ('te-backlog-1', 'fr-backlog-1', 'Covered.', 'unit', 0, 1, ?, ?)`,
    )
    .run(now, now);
  raw.close();
  return { filePath, planId };
}

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createPlanCommand());
  return program;
}

describe('CLI plan validate-backlog (issue #104)', () => {
  let dbPath: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['DB_DIALECT'];
    delete process.env['DB_PATH'];
    if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    dbPath = undefined;
  });

  it('--json prints the same field shape as before (command/projectId/planId/resultingState)', async () => {
    const seeded = createMigratedSqliteFileWithValidBacklog();
    dbPath = seeded.filePath;
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'plan',
      'validate-backlog',
      '--project',
      'proj-backlog-1',
      '--plan',
      seeded.planId,
      '--json',
    ]);
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    const parsed = JSON.parse(printed);
    expect(parsed).toEqual({
      command: 'plan validate-backlog',
      projectId: 'proj-backlog-1',
      planId: seeded.planId,
      resultingState: 'valid',
    });
  });

  it('without --json, renders via Ink instead of throwing', async () => {
    const seeded = createMigratedSqliteFileWithValidBacklog();
    dbPath = seeded.filePath;
    process.env['DB_DIALECT'] = 'sqlite';
    process.env['DB_PATH'] = dbPath;

    await expect(
      makeProgram().parseAsync([
        'node',
        'minicoder',
        'plan',
        'validate-backlog',
        '--project',
        'proj-backlog-1',
        '--plan',
        seeded.planId,
      ]),
    ).resolves.not.toThrow();
  });
});
