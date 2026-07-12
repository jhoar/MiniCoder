import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import { ProjectState } from '@minicoder/core';
import type { DbClient } from '@minicoder/core';
import { runDoctorChecks } from './diagnostics.js';

/**
 * Issue #69's "accept and monitor" resolution: `MarkImplementationCompleteHandler`'s
 * `SERIALIZABLE` fence only protects against concurrent invocations of
 * `MarkImplementationCompleteCommand` itself, not every other acceptance-invalidating writer
 * (RecordCiFailedHandler, review-finding writers, etc., none of which participate in that fence).
 * `project_acceptance_violated` re-runs `evaluateProjectAcceptance()` against every project past
 * the acceptance gate (any state after `active`) so a rare violation surfaces here instead of
 * silently persisting forever.
 */
async function seedProject(
  db: DbClient,
  projectId: string,
  state: string,
  updatedAt?: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', ?, 1, datetime('now'), ?)`,
    [projectId, state, updatedAt ?? new Date().toISOString()],
  );
}

async function seedNonTerminalFeature(
  db: DbClient,
  projectId: string,
  featureRunId: string,
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
     VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, 'approved', 0, 1, datetime('now'), datetime('now'))`,
    [frId, planId, projectId],
  );
  // Not merged/skipped -- exactly the class of write a non-SERIALIZABLE handler (e.g.
  // RecordCiFailedHandler) could commit in the race window MarkImplementationCompleteHandler's
  // own fence does not cover, per issue #69.
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, fix_attempt_count, version, created_at, updated_at)
     VALUES (?, ?, 1, 'coding', 0, 1, datetime('now'), datetime('now'))`,
    [featureRunId, frId],
  );
}

describe('runDoctorChecks: project_acceptance_violated (issue #69)', () => {
  it('flags a post-acceptance project whose current state would now fail acceptance', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-acceptance-violated';
    await seedProject(db, projectId, ProjectState.IMPLEMENTATION_COMPLETE);
    await seedNonTerminalFeature(db, projectId, 'run-violated-1');

    const result = await runDoctorChecks(db, projectId);
    const check = result.checks.find((c) => c.name === 'project_acceptance_violated');
    expect(check?.severity).toBe('error');
    expect(check?.count).toBe(1);
    expect((check?.details as Array<{ projectId: string }>)[0]?.projectId).toBe(projectId);
    expect(result.healthy).toBe(false);
  });

  it('does not flag a post-acceptance project whose current state still passes acceptance', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-acceptance-clean';
    await seedProject(db, projectId, ProjectState.IMPLEMENTATION_COMPLETE);

    const result = await runDoctorChecks(db, projectId);
    const check = result.checks.find((c) => c.name === 'project_acceptance_violated');
    expect(check?.severity).toBe('ok');
    expect(check?.count).toBe(0);
  });

  it('does not evaluate a project still at active (not yet past the acceptance gate)', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-acceptance-still-active';
    await seedProject(db, projectId, ProjectState.ACTIVE);
    await seedNonTerminalFeature(db, projectId, 'run-active-1');

    const result = await runDoctorChecks(db, projectId);
    const check = result.checks.find((c) => c.name === 'project_acceptance_violated');
    expect(check?.severity).toBe('ok');
    expect(check?.count).toBe(0);
  });

  it('flags a violation in design_document_generating and later lifecycle states too', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-acceptance-design-doc';
    await seedProject(db, projectId, ProjectState.DESIGN_DOCUMENT_GENERATING);
    await seedNonTerminalFeature(db, projectId, 'run-design-doc-1');

    const result = await runDoctorChecks(db, projectId);
    const check = result.checks.find((c) => c.name === 'project_acceptance_violated');
    expect(check?.severity).toBe('error');
    expect(check?.count).toBe(1);
  });

  // PR #73 review round 2 (HIGH-1): an earlier revision bounded this sweep to the 50
  // most-recently-updated post-acceptance projects, which meant a violating project outside that
  // window would never be flagged -- a real correctness regression, since this check exists to
  // catch a rare-but-real concurrency violation, not to act as a best-effort audit sample.
  // Reverted to an exhaustive sweep; this proves it stays exhaustive past the old bound.
  it('still flags a violating project outside a 50-project recency window (global sweep, no --project)', async () => {
    const db = createTestDb() as unknown as DbClient;
    const now = Date.now();

    // The violating project is the *oldest* by updated_at -- if the sweep were bounded to the
    // most-recently-updated N projects (as it was in a prior revision), this project would never
    // be reached.
    const violatingProjectId = 'proj-acceptance-old-violator';
    await seedProject(
      db,
      violatingProjectId,
      ProjectState.IMPLEMENTATION_COMPLETE,
      new Date(now - 1_000_000).toISOString(),
    );
    await seedNonTerminalFeature(db, violatingProjectId, 'run-old-violator-1');

    for (let i = 0; i < 55; i++) {
      await seedProject(
        db,
        `proj-acceptance-recent-clean-${i}`,
        ProjectState.IMPLEMENTATION_COMPLETE,
        new Date(now - i * 1000).toISOString(),
      );
    }

    const result = await runDoctorChecks(db);
    const check = result.checks.find((c) => c.name === 'project_acceptance_violated');
    expect(check?.severity).toBe('error');
    expect(check?.count).toBe(1);
    expect((check?.details as Array<{ projectId: string }>)[0]?.projectId).toBe(violatingProjectId);
  });
});
