import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import type { DbClient } from '@minicoder/core';
import { runDoctorChecks } from './diagnostics.js';

/**
 * Phase 16: coverage for the two doctor checks added to `runDoctorChecks()` —
 * `code_pushed_no_pull_request` (closes the previously-deferred LOW-3 observability gap) and
 * `secret_leak_scan` (docs/07 "private chain-of-thought is never stored" defense-in-depth audit).
 */

async function seedProject(db: DbClient, projectId: string): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
    [projectId],
  );
}

async function seedCodePushedRun(
  db: DbClient,
  projectId: string,
  featureRunId: string,
  startedAt: string,
): Promise<void> {
  const planId = `plan-${featureRunId}`;
  const frId = `fr-${featureRunId}`;
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
    [planId, projectId],
  );
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, 'code_pushed', 0, 1, datetime('now'), datetime('now'))`,
    [frId, planId, projectId],
  );
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
     VALUES (?, ?, 1, 'code_pushed', ?, 1, datetime('now'), datetime('now'))`,
    [featureRunId, frId, startedAt],
  );
}

describe('runDoctorChecks: code_pushed_no_pull_request', () => {
  it('flags a code_pushed run past the grace period with no tracked PR', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-no-pr-doctor';
    await seedProject(db, projectId);
    const oldStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await seedCodePushedRun(db, projectId, 'run-no-pr-1', oldStartedAt);

    const result = await runDoctorChecks(db, projectId);
    const check = result.checks.find((c) => c.name === 'code_pushed_no_pull_request');
    expect(check?.severity).toBe('warning');
    expect(check?.count).toBe(1);
  });

  it('does not flag a run still inside the grace period', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-no-pr-doctor-fresh';
    await seedProject(db, projectId);
    const recentStartedAt = new Date().toISOString();
    await seedCodePushedRun(db, projectId, 'run-no-pr-2', recentStartedAt);

    const result = await runDoctorChecks(db, projectId);
    const check = result.checks.find((c) => c.name === 'code_pushed_no_pull_request');
    expect(check?.severity).toBe('ok');
    expect(check?.count).toBe(0);
  });

  it('does not flag a run that already has a tracked PR', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-no-pr-doctor-tracked';
    await seedProject(db, projectId);
    const oldStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const featureRunId = 'run-no-pr-3';
    await seedCodePushedRun(db, projectId, featureRunId, oldStartedAt);
    await db.execute(
      `INSERT INTO pull_requests (id, feature_run_id, pr_number, branch_name, base_branch, state, head_sha, version, created_at, updated_at)
       VALUES (?, ?, 1, 'minicoder/run-no-pr-3', 'main', 'open', 'abc123', 1, datetime('now'), datetime('now'))`,
      [`pr-${featureRunId}`, featureRunId],
    );

    const result = await runDoctorChecks(db, projectId);
    const check = result.checks.find((c) => c.name === 'code_pushed_no_pull_request');
    expect(check?.severity).toBe('ok');
    expect(check?.count).toBe(0);
  });
});

describe('runDoctorChecks: secret_leak_scan', () => {
  async function seedAgentRunRow(db: DbClient, id: string): Promise<void> {
    await db.execute(
      `INSERT INTO agent_adapters (id, role, name, implementation, version, is_active, created_at, updated_at)
       VALUES (?, 'CoderAgentAdapter', 'MockCoderAdapter', 'mock', '1.0.0', 1, datetime('now'), datetime('now'))`,
      [`adapter-${id}`],
    );
    await db.execute(
      `INSERT INTO agent_runs (id, adapter_id, role, state, version, created_at, updated_at)
       VALUES (?, ?, 'CoderAgentAdapter', 'succeeded', 1, datetime('now'), datetime('now'))`,
      [id, `adapter-${id}`],
    );
  }

  it('flags an un-redacted secret in a recent agent_context_packs row', async () => {
    const db = createTestDb() as unknown as DbClient;
    const runId = 'agent-run-secret-1';
    await seedAgentRunRow(db, runId);
    await db.execute(
      `INSERT INTO agent_context_packs (id, agent_run_id, content, version, created_at, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`,
      [`pack-${runId}`, runId, 'token: ghp_abc123def456ghi789jkl012mno345pqr678'],
    );

    const result = await runDoctorChecks(db);
    const check = result.checks.find((c) => c.name === 'secret_leak_scan');
    expect(check?.severity).toBe('error');
    expect(check?.count).toBeGreaterThanOrEqual(1);
  });

  it('flags an un-redacted secret in agent_runs.output_summary', async () => {
    const db = createTestDb() as unknown as DbClient;
    const runId = 'agent-run-secret-2';
    await seedAgentRunRow(db, runId);
    await db.execute(`UPDATE agent_runs SET output_summary = ? WHERE id = ?`, [
      'sk-' + 'a'.repeat(40),
      runId,
    ]);

    const result = await runDoctorChecks(db);
    const check = result.checks.find((c) => c.name === 'secret_leak_scan');
    expect(check?.severity).toBe('error');
  });

  it('reports ok when no sampled rows contain secret-shaped content', async () => {
    const db = createTestDb() as unknown as DbClient;
    const runId = 'agent-run-clean-1';
    await seedAgentRunRow(db, runId);
    await db.execute(
      `INSERT INTO agent_context_packs (id, agent_run_id, content, version, created_at, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`,
      [`pack-${runId}`, runId, '{"featureRunId":"abc-123","summary":"clean"}'],
    );

    const result = await runDoctorChecks(db);
    const check = result.checks.find((c) => c.name === 'secret_leak_scan');
    expect(check?.severity).toBe('ok');
    expect(check?.count).toBe(0);
  });
});
