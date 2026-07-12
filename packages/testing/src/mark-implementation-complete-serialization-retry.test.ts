import { describe, it, expect } from 'vitest';
import {
  MarkImplementationCompleteHandler,
  ProjectState,
  SerializationFailureError,
  generateId,
} from '@minicoder/core';
import type { MarkImplementationCompletePayload } from '@minicoder/core';
import type { CommandEnvelope, DbClient, TxClient, TransactionOptions } from '@minicoder/core';
import { createTestDb } from './db.js';

const PROJECT_ID = 'proj-mic-serialization-retry-001';

const systemActor = {
  id: 'system',
  role: 'admin' as const,
  actorKind: 'system' as const,
  correlationId: 'corr-1',
};

/** Wraps a real DbClient, forcing its `transaction()` to fail with `SerializationFailureError`
 * on the first N calls before delegating normally — simulates a PostgreSQL SSI conflict without
 * needing a live Postgres instance, so this exercises `MarkImplementationCompleteHandler.execute()`'s
 * own retry loop against a real SQLite-backed transaction body.
 *
 * Critically, the forced failure is thrown INSIDE the callback passed to the real
 * `inner.transaction()` — after the real transaction function `fn` has already run to completion
 * (claimed the idempotency key, executed the guarded `UPDATE`, written `human_approvals`/
 * `workflow_events`/`outbox_events`) — not before `inner.transaction()` is even called. That
 * means the real `SqliteDbClient.transaction()` sees the throw and performs a REAL `ROLLBACK`,
 * undoing all of that body's work exactly the way a genuine PostgreSQL `COMMIT`-time `40001`
 * would. This proves the retry loop's safety property (a failed attempt leaves no partial rows to
 * collide with a later successful retry), not just that the loop calls a function N times before
 * returning. */
function withForcedSerializationFailures(inner: DbClient, failuresBeforeSuccess: number): DbClient {
  let attempts = 0;
  return {
    query: inner.query.bind(inner),
    execute: inner.execute.bind(inner),
    executeAffected: inner.executeAffected.bind(inner),
    close: inner.close.bind(inner),
    async transaction<T>(fn: (tx: TxClient) => Promise<T>, opts?: TransactionOptions): Promise<T> {
      attempts++;
      const shouldFail = attempts <= failuresBeforeSuccess;
      return inner.transaction(async (tx) => {
        const result = await fn(tx);
        if (shouldFail) {
          throw new SerializationFailureError(new Error('simulated SSI conflict at commit'));
        }
        return result;
      }, opts);
    },
  };
}

describe('MarkImplementationCompleteHandler serialization-failure retry', () => {
  it('retries the whole transaction and succeeds after a simulated SERIALIZABLE conflict', async () => {
    const realDb = createTestDb();
    await realDb.execute(
      `INSERT INTO projects (id, name, state, version, created_at, updated_at)
       VALUES (?, 'Test Project', ?, 1, datetime('now'), datetime('now'))`,
      [PROJECT_ID, ProjectState.ACTIVE],
    );
    const db = withForcedSerializationFailures(realDb, 2);

    const handler = new MarkImplementationCompleteHandler();
    const result = await handler.execute(
      {
        commandId: generateId(),
        idempotencyKey: 'mic-retry-1',
        payload: {
          projectId: PROJECT_ID,
          expectedVersion: 1,
          externalChecksEvidence: 'CI run https://example.test/ci/456 passed',
        },
        actor: systemActor,
        correlationId: 'corr-1',
      } as CommandEnvelope<MarkImplementationCompletePayload>,
      db,
    );

    expect(result.accepted).toBe(true);
    expect(result.resultingState).toBe(ProjectState.IMPLEMENTATION_COMPLETE);

    const rows = await realDb.query<{ state: string }>(`SELECT state FROM projects WHERE id = ?`, [
      PROJECT_ID,
    ]);
    expect(rows[0]?.state).toBe(ProjectState.IMPLEMENTATION_COMPLETE);

    // Exactly one of each audit/event row survives — the two forced-failure attempts' own writes
    // (human_approvals, workflow_events, outbox_events, the idempotency claim) were genuinely
    // rolled back, not left behind as duplicates alongside the successful third attempt's rows.
    const approvals = await realDb.query<{ id: string }>(
      `SELECT id FROM human_approvals WHERE project_id = ? AND context_type = 'project_acceptance_external_checks'`,
      [PROJECT_ID],
    );
    expect(approvals).toHaveLength(1);
    const events = await realDb.query<{ id: string }>(
      `SELECT id FROM workflow_events WHERE project_id = ? AND event_type = 'project.implementation_complete'`,
      [PROJECT_ID],
    );
    expect(events).toHaveLength(1);
    const outbox = await realDb.query<{ id: string }>(
      `SELECT id FROM outbox_events WHERE event_type = 'project.implementation_complete'`,
      [],
    );
    expect(outbox).toHaveLength(1);
  });

  it('gives up after exhausting retries, leaving no partial rows committed', async () => {
    const realDb = createTestDb();
    await realDb.execute(
      `INSERT INTO projects (id, name, state, version, created_at, updated_at)
       VALUES (?, 'Test Project', ?, 1, datetime('now'), datetime('now'))`,
      [PROJECT_ID, ProjectState.ACTIVE],
    );
    // More forced failures than the handler's retry budget — every attempt fails, each one
    // still running the real transaction body (claim, guarded UPDATE, audit writes) before the
    // simulated commit-time conflict rolls it all back.
    const db = withForcedSerializationFailures(realDb, 10);

    const handler = new MarkImplementationCompleteHandler();

    await expect(
      handler.execute(
        {
          commandId: generateId(),
          idempotencyKey: 'mic-retry-2',
          payload: {
            projectId: PROJECT_ID,
            expectedVersion: 1,
            externalChecksEvidence: 'CI run https://example.test/ci/789 passed',
          },
          actor: systemActor,
          correlationId: 'corr-1',
        } as CommandEnvelope<MarkImplementationCompletePayload>,
        db,
      ),
    ).rejects.toBeInstanceOf(SerializationFailureError);

    const rows = await realDb.query<{ state: string }>(`SELECT state FROM projects WHERE id = ?`, [
      PROJECT_ID,
    ]);
    expect(rows[0]?.state).toBe(ProjectState.ACTIVE);

    const approvals = await realDb.query<{ id: string }>(
      `SELECT id FROM human_approvals WHERE project_id = ? AND context_type = 'project_acceptance_external_checks'`,
      [PROJECT_ID],
    );
    expect(approvals).toHaveLength(0);
    const outbox = await realDb.query<{ id: string }>(
      `SELECT id FROM outbox_events WHERE event_type = 'project.implementation_complete'`,
      [],
    );
    expect(outbox).toHaveLength(0);
  });
});
