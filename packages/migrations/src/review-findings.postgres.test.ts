import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { PostgresDbClient } from '@minicoder/persistence-postgres';
import { insertReviewFindings, RecordCodePushedHandler } from '@minicoder/core';
import type { CommandEnvelope } from '@minicoder/core';

// Requires MINICODER_TEST_PG_URL — see runner.postgres.test.ts for rationale. This suite guards
// against a real Phase 10 regression: `review_findings.resolved` is BOOLEAN in PostgreSQL
// (migration 0001), and bare integer literals (`0`/`1`) against it are rejected by PostgreSQL
// ("column is of type boolean but expression is of type integer") even though SQLite accepts them
// (no real boolean type). `insertReviewFindings()`, run-coder.ts's open-findings query, and
// `RecordCodePushedHandler`'s resolved-update all had this bug — fixed to use `FALSE`/`TRUE` SQL
// keywords, which are portable across both dialects.
const TEST_PG_URL = process.env['MINICODER_TEST_PG_URL'];
const RUN_PG = !!TEST_PG_URL;

const TEST_SCHEMA = 'minicoder_test_review_findings';
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

function listPgMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.postgres.sql') && !f.includes('.down.'))
    .sort();
}

async function applyAllMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (const file of listPgMigrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [
        file.replace(/\.postgres\.sql$/, ''),
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

describe.skipIf(!RUN_PG)('review_findings.resolved boolean handling (PostgreSQL)', () => {
  let pool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: TEST_PG_URL! });
    await adminPool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await adminPool.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await adminPool.end();

    const url = new URL(TEST_PG_URL!);
    url.searchParams.set('options', `-c search_path="${TEST_SCHEMA}"`);
    pool = new Pool({ connectionString: url.toString() });

    await applyAllMigrations(pool);

    const seed = await pool.connect();
    try {
      await seed.query(
        `INSERT INTO projects (id, name, description, state, version, created_at, updated_at)
         VALUES ('proj-pg-1', 'P', 'D', 'active', 1, NOW(), NOW())`,
      );
      await seed.query(
        `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
         VALUES ('plan-pg-1', 'proj-pg-1', NULL, 'activated_for_execution', 'Plan', 'Summary', 1, NOW(), NOW())`,
      );
      await seed.query(
        `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
         VALUES ('fr-pg-1', 'plan-pg-1', 'proj-pg-1', 'FR-001', 'T', 'D', 'feature', TRUE, 'fixing', 0, 1, NOW(), NOW())`,
      );
      await seed.query(
        `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
         VALUES ('run-pg-1', 'fr-pg-1', 1, 'fixing', 1, NOW(), NOW())`,
      );
      await seed.query(
        `INSERT INTO agent_adapters (id, role, name, implementation, is_active, version, created_at, updated_at)
         VALUES ('adapter-pg-1', 'CoderAgentAdapter', 'PgTestCoderAdapter', 'test:pg', TRUE, 1, NOW(), NOW())`,
      );
      await seed.query(
        `INSERT INTO agent_runs (id, adapter_id, project_id, feature_run_id, role, state, version, created_at, updated_at)
         VALUES ('agent-run-pg-1', 'adapter-pg-1', 'proj-pg-1', 'run-pg-1', 'CoderAgentAdapter', 'succeeded', 1, NOW(), NOW())`,
      );
    } finally {
      seed.release();
    }
  });

  afterAll(async () => {
    await pool.end();
    const adminPool = new Pool({ connectionString: TEST_PG_URL! });
    await adminPool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await adminPool.end();
  });

  it('insertReviewFindings writes resolved=FALSE and the open-findings-style query finds it', async () => {
    const client = await pool.connect();
    try {
      const db = new PostgresDbClient(client);
      await insertReviewFindings(db, {
        featureRunId: 'run-pg-1',
        reviewerRunId: null,
        reviewCycle: 1,
        findings: [{ severity: 'blocking', category: 'correctness', description: 'bug' }],
      });

      // Mirrors run-coder.ts's open-findings query exactly.
      const open = await db.query<{ id: string }>(
        `SELECT id FROM review_findings WHERE feature_run_id = $1 AND resolved = FALSE`,
        ['run-pg-1'],
      );
      expect(open).toHaveLength(1);
      const findingId = open[0]!.id;

      // RecordCodePushedHandler's resolved-update, exercised directly against a real lock-gated
      // fixing -> code_pushed transition.
      const handler = new RecordCodePushedHandler();
      const envelope: CommandEnvelope<{
        featureRunId: string;
        projectId: string;
        expectedVersion: number;
        commitSha: string;
        branchName: string;
        filesChanged: number;
        coderRunId?: string;
        resolvedFindingIds?: string[];
      }> = {
        commandId: 'cmd-pg-1',
        idempotencyKey: 'record-code-pushed:run-pg-1:sha-pg-1',
        payload: {
          featureRunId: 'run-pg-1',
          projectId: 'proj-pg-1',
          expectedVersion: 1,
          commitSha: 'sha-pg-1',
          branchName: 'minicoder/x',
          filesChanged: 1,
          coderRunId: 'agent-run-pg-1',
          resolvedFindingIds: [findingId],
        },
        actor: {
          id: 'workflow-layer',
          role: 'admin' as const,
          actorKind: 'system' as const,
          correlationId: 'corr-pg-1',
        },
        correlationId: 'corr-pg-1',
        lockContext: {
          lockId: 'lock-pg-1',
          fence: 1,
          holderId: 'test-holder',
          projectId: 'proj-pg-1',
          resourceKey: 'execution-lane:proj-pg-1',
        },
      };

      // No real lock row exists, so assertLockFence would normally reject this — this test only
      // needs to prove the boolean SQL is valid PostgreSQL, not the full lock-fence contract
      // (already covered elsewhere), so seed a matching workflow_locks row first.
      await client.query(
        `INSERT INTO workflow_locks (id, project_id, resource_key, holder_id, fence, expires_at, version, created_at, updated_at)
         VALUES ('lock-pg-1', 'proj-pg-1', 'execution-lane:proj-pg-1', 'test-holder', 1, NOW() + interval '1 hour', 1, NOW(), NOW())`,
      );

      await handler.execute(envelope, db);

      const resolvedRows = await db.query<{ resolved: boolean }>(
        `SELECT resolved FROM review_findings WHERE id = $1`,
        [findingId],
      );
      expect(resolvedRows[0]?.resolved).toBe(true);

      const stillOpen = await db.query<{ id: string }>(
        `SELECT id FROM review_findings WHERE feature_run_id = $1 AND resolved = FALSE`,
        ['run-pg-1'],
      );
      expect(stillOpen).toHaveLength(0);
    } finally {
      client.release();
    }
  });
});
