import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { PostgresDbClient } from './client.js';
import { RollbackFailedError } from '@minicoder/core';
import type { TxClient } from '@minicoder/core';

// Minimal PoolClient mock — only the methods PostgresDbClient actually calls.
function makeMockClient(
  queryImpl?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
): PoolClient {
  return {
    query: vi
      .fn()
      .mockImplementation(queryImpl ?? ((_sql: string) => Promise.resolve({ rows: [] }))),
    release: vi.fn(),
  } as unknown as PoolClient;
}

describe('PostgresDbClient.transaction()', () => {
  let mockPg: ReturnType<typeof makeMockClient>;
  let client: PostgresDbClient;

  beforeEach(() => {
    mockPg = makeMockClient();
    client = new PostgresDbClient(mockPg);
  });

  it('issues BEGIN and COMMIT when the callback succeeds', async () => {
    const queryMock = mockPg.query as ReturnType<typeof vi.fn>;

    await client.transaction(async (tx: TxClient) => {
      await tx.execute('INSERT INTO t VALUES (1)');
    });

    const calls: string[] = queryMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('COMMIT');
    expect(calls).not.toContain('ROLLBACK');
  });

  it('issues ROLLBACK when the callback throws', async () => {
    const queryMock = mockPg.query as ReturnType<typeof vi.fn>;

    await expect(
      client.transaction(async (_tx: TxClient) => {
        throw new Error('callback error');
      }),
    ).rejects.toThrow('callback error');

    const calls: string[] = queryMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  // Replaces the previous inside-callback test which did not exercise the async
  // race. Here we use a deferred BEGIN: execute() is started BEFORE BEGIN
  // resolves. With the flag set before await, execute() sees inTransaction=true
  // immediately and the SQL never reaches the driver.
  it('rejects outer execute() started before BEGIN resolves (async race guard)', async () => {
    let resolveBEGIN!: () => void;
    const deferredBEGIN = new Promise<{ rows: unknown[] }>((resolve) => {
      resolveBEGIN = () => resolve({ rows: [] });
    });

    const racePg = makeMockClient((sql: string) => {
      if (sql === 'BEGIN') return deferredBEGIN;
      return Promise.resolve({ rows: [] });
    });
    const raceClient = new PostgresDbClient(racePg);

    // Start the transaction — it sets inTransaction=true, then suspends at BEGIN
    const txPromise = raceClient.transaction(async () => {});

    // Attempt an outer execute BEFORE BEGIN has resolved — must be rejected immediately
    const executePromise = raceClient.execute('INSERT INTO t VALUES (99)');

    // Resolve BEGIN to unblock the transaction
    resolveBEGIN();

    await expect(executePromise).rejects.toThrow(/transaction/i);
    await txPromise;

    // The rogue SQL must never have reached the driver
    const calls: string[] = (racePg.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(calls).not.toContain('INSERT INTO t VALUES (99)');
  });

  it('rejects outer client.query() while transaction is active', async () => {
    await expect(
      client.transaction(async (_tx: TxClient) => {
        await client.query('SELECT 1');
      }),
    ).rejects.toThrow(/transaction/i);
  });

  it('rejects nested transaction() calls', async () => {
    await expect(
      client.transaction(async (_tx: TxClient) => {
        await client.transaction(async (_tx2: TxClient) => {
          await _tx2.execute('SELECT 1');
        });
      }),
    ).rejects.toThrow(/nested/i);
  });

  it('resets inTransaction after a failed BEGIN — client remains usable', async () => {
    let beginAttempts = 0;
    const faultyPg = makeMockClient((sql: string) => {
      if (sql === 'BEGIN') {
        beginAttempts++;
        if (beginAttempts === 1) return Promise.reject(new Error('connection reset'));
      }
      return Promise.resolve({ rows: [] });
    });
    const faultyClient = new PostgresDbClient(faultyPg);

    // First transaction — BEGIN fails
    await expect(faultyClient.transaction(async () => {})).rejects.toThrow('connection reset');

    // Client must not be poisoned: execute() should work after a failed BEGIN
    await expect(faultyClient.execute('SELECT 1')).resolves.toBeUndefined();
  });

  it('does not attempt ROLLBACK when BEGIN itself failed', async () => {
    const faultyPg = makeMockClient((sql: string) => {
      if (sql === 'BEGIN') return Promise.reject(new Error('no connection'));
      return Promise.resolve({ rows: [] });
    });
    const faultyClient = new PostgresDbClient(faultyPg);

    await expect(faultyClient.transaction(async () => {})).rejects.toThrow('no connection');

    const calls: string[] = (faultyPg.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(calls).toEqual(['BEGIN']);
  });

  it('marks client dead and wraps both errors when ROLLBACK fails', async () => {
    const callbackError = new Error('callback failed');
    const rollbackError = new Error('ROLLBACK failed');

    const faultyPg = makeMockClient((sql: string) => {
      if (sql === 'ROLLBACK') return Promise.reject(rollbackError);
      return Promise.resolve({ rows: [] });
    });
    const faultyClient = new PostgresDbClient(faultyPg);

    const err = await faultyClient
      .transaction(async (_tx: TxClient) => {
        throw callbackError;
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RollbackFailedError);
    expect((err as RollbackFailedError).originalError).toBe(callbackError);
    expect((err as RollbackFailedError).rollbackError).toBe(rollbackError);

    // Client must be dead — any further operation throws
    await expect(faultyClient.execute('SELECT 1')).rejects.toThrow(/unusable/i);
    await expect(faultyClient.query('SELECT 1')).rejects.toThrow(/unusable/i);
    await expect(faultyClient.transaction(async () => {})).rejects.toThrow(/unusable/i);
  });

  it('releases the pool connection with the rollback error when ROLLBACK fails', async () => {
    const rollbackError = new Error('ROLLBACK failed');
    const faultyPg = makeMockClient((sql: string) => {
      if (sql === 'ROLLBACK') return Promise.reject(rollbackError);
      return Promise.resolve({ rows: [] });
    });
    const releaseMock = faultyPg.release as ReturnType<typeof vi.fn>;
    const faultyClient = new PostgresDbClient(faultyPg);

    await faultyClient
      .transaction(async (_tx: TxClient) => {
        throw new Error('callback failed');
      })
      .catch(() => {});

    // pg pool must be informed the connection is bad so it can discard it
    expect(releaseMock).toHaveBeenCalledWith(rollbackError);
  });

  it('close() does not call release() again after ROLLBACK failure', async () => {
    const faultyPg = makeMockClient((sql: string) => {
      if (sql === 'ROLLBACK') return Promise.reject(new Error('ROLLBACK failed'));
      return Promise.resolve({ rows: [] });
    });
    const releaseMock = faultyPg.release as ReturnType<typeof vi.fn>;
    const faultyClient = new PostgresDbClient(faultyPg);

    await faultyClient
      .transaction(async (_tx: TxClient) => {
        throw new Error('callback failed');
      })
      .catch(() => {});

    // release() was already called with the error during ROLLBACK failure
    const callsBeforeClose = releaseMock.mock.calls.length;
    await faultyClient.close();

    // close() must not call release() a second time on a dead client
    expect(releaseMock.mock.calls.length).toBe(callsBeforeClose);
  });
});
