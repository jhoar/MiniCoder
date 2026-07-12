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
 * on the first N calls before delegating normally — simulates a PostgreSQL SSI conflict at
 * COMMIT without needing a live Postgres instance, so this exercises `MarkImplementationComplete
 * Handler.execute()`'s own retry loop against a real SQLite-backed transaction body. */
function withForcedSerializationFailures(inner: DbClient, failuresBeforeSuccess: number): DbClient {
  let attempts = 0;
  return {
    query: inner.query.bind(inner),
    execute: inner.execute.bind(inner),
    executeAffected: inner.executeAffected.bind(inner),
    close: inner.close.bind(inner),
    async transaction<T>(fn: (tx: TxClient) => Promise<T>, opts?: TransactionOptions): Promise<T> {
      attempts++;
      if (attempts <= failuresBeforeSuccess) {
        throw new SerializationFailureError(new Error('simulated SSI conflict'));
      }
      return inner.transaction(fn, opts);
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
  });

  it('gives up and throws SerializationFailureError after exhausting retries', async () => {
    const realDb = createTestDb();
    await realDb.execute(
      `INSERT INTO projects (id, name, state, version, created_at, updated_at)
       VALUES (?, 'Test Project', ?, 1, datetime('now'), datetime('now'))`,
      [PROJECT_ID, ProjectState.ACTIVE],
    );
    // More forced failures than the handler's retry budget — every attempt fails.
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
  });
});
