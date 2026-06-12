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

export class PostgresDbClient implements DbClient {
  constructor(private readonly client: PoolClient) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.client.query(sql, params);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.client.query(sql, params);
  }

  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    const tx = new PostgresTxClient(this.client);
    try {
      const result = await fn(tx);
      await this.client.query('COMMIT');
      return result;
    } catch (err) {
      await this.client.query('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    this.client.release();
  }
}
