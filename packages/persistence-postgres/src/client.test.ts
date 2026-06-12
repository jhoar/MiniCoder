import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { PostgresDbClient } from './client.js';
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

  it('rejects outer client.execute() while transaction is active — no interleaving', async () => {
    const queryMock = mockPg.query as ReturnType<typeof vi.fn>;

    await expect(
      client.transaction(async (_tx: TxClient) => {
        // Attempt to bypass tx and use the outer client directly
        await client.execute('INSERT INTO t VALUES (99)');
      }),
    ).rejects.toThrow(/transaction/i);

    // The interleaved execute never reached pg — only BEGIN and ROLLBACK ran
    const calls: string[] = queryMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('ROLLBACK');
    // The rogue INSERT must not have reached the database
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
    // Only BEGIN was attempted; ROLLBACK must not have been called
    expect(calls).toEqual(['BEGIN']);
  });
});
