import type { PoolClient } from 'pg';
import type { DbClient, TxClient } from '@minicoder/core';

class PostgresTxClient implements TxClient {
  constructor(private readonly client: PoolClient) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.client.query(sql, params);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.client.query(sql, params);
  }
}

const TX_ACTIVE_MSG =
  'Cannot call DbClient.%s() while a transaction is active; use the tx client passed to the transaction callback.';

export class PostgresDbClient implements DbClient {
  private inTransaction = false;

  constructor(private readonly client: PoolClient) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.inTransaction) throw new Error(TX_ACTIVE_MSG.replace('%s', 'query'));
    const result = await this.client.query(sql, params);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (this.inTransaction) throw new Error(TX_ACTIVE_MSG.replace('%s', 'execute'));
    await this.client.query(sql, params);
  }

  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    if (this.inTransaction) throw new Error('Nested transactions are not supported.');
    // Flag is set BEFORE awaiting BEGIN so no concurrent outer operation can
    // slip through the async window between BEGIN completing and the flag update.
    // The finally block always resets it, even if BEGIN itself throws.
    this.inTransaction = true;
    let rollbackRequired = false;
    try {
      await this.client.query('BEGIN');
      rollbackRequired = true;
      const tx = new PostgresTxClient(this.client);
      const result = await fn(tx);
      await this.client.query('COMMIT');
      rollbackRequired = false;
      return result;
    } catch (err) {
      if (rollbackRequired) {
        try {
          await this.client.query('ROLLBACK');
        } catch {
          // ignore — connection may be dead; flag resets in finally
        }
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  async close(): Promise<void> {
    this.client.release();
  }
}
