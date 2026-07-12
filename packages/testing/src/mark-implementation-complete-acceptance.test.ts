import { describe, it, expect } from 'vitest';
import {
  MarkImplementationCompleteHandler,
  ProjectState,
  TransactionalCommandExecutor,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import { createTestDb } from './db.js';

const PROJECT_ID = 'proj-mic-acceptance-001';

const systemActor = {
  id: 'system',
  role: 'admin' as const,
  actorKind: 'system' as const,
  correlationId: 'corr-1',
};

async function seedActiveProjectWithNonTerminalFeature(db: DbClient): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', ?, 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID, ProjectState.ACTIVE],
  );
  const planId = `plan-${PROJECT_ID}`;
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
    [planId, PROJECT_ID],
  );
  const frId = `fr-${PROJECT_ID}`;
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Add widget', 'Description', 'feature', 1, 'approved', 0, 1, datetime('now'), datetime('now'))`,
    [frId, planId, PROJECT_ID],
  );
  // A feature run that is still mid-flight (not merged/skipped) — this is the exact predicate the
  // guarded UPDATE's NOT EXISTS clause (and evaluateProjectAcceptance()'s pre-check) must catch.
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, fix_attempt_count, version, created_at, updated_at)
     VALUES (?, ?, 1, 'coding', 0, 1, datetime('now'), datetime('now'))`,
    [`run-${PROJECT_ID}`, frId],
  );
}

describe('MarkImplementationCompleteHandler acceptance guard', () => {
  it('rejects with project-acceptance-failed when a feature run is not terminal, without mutating project state', async () => {
    const db = createTestDb();
    await seedActiveProjectWithNonTerminalFeature(db);

    const executor = new TransactionalCommandExecutor(db);
    const handler = new MarkImplementationCompleteHandler();

    await expect(
      executor.execute(handler, {
        commandId: generateId(),
        idempotencyKey: 'mic-acceptance-1',
        payload: {
          projectId: PROJECT_ID,
          expectedVersion: 1,
          externalChecksEvidence: 'CI run https://example.test/ci/123 passed',
        },
        actor: systemActor,
        correlationId: 'corr-1',
      } as CommandEnvelope<Record<string, unknown>>),
    ).rejects.toMatchObject({ problem: { type: 'project-acceptance-failed' } });

    const rows = await db.query<{ state: string; version: number }>(
      `SELECT state, version FROM projects WHERE id = ?`,
      [PROJECT_ID],
    );
    expect(rows[0]?.state).toBe(ProjectState.ACTIVE);
    expect(rows[0]?.version).toBe(1);
  });

  it('rejects when externalChecksEvidence is blank, even if acceptance would otherwise pass', async () => {
    const db = createTestDb();
    await db.execute(
      `INSERT INTO projects (id, name, state, version, created_at, updated_at)
       VALUES (?, 'Test Project', ?, 1, datetime('now'), datetime('now'))`,
      [PROJECT_ID, ProjectState.ACTIVE],
    );

    const executor = new TransactionalCommandExecutor(db);
    const handler = new MarkImplementationCompleteHandler();

    await expect(
      executor.execute(handler, {
        commandId: generateId(),
        idempotencyKey: 'mic-evidence-1',
        payload: { projectId: PROJECT_ID, expectedVersion: 1, externalChecksEvidence: '   ' },
        actor: systemActor,
        correlationId: 'corr-1',
      } as CommandEnvelope<Record<string, unknown>>),
    ).rejects.toMatchObject({ problem: { type: 'external-checks-evidence-required' } });
  });
});
