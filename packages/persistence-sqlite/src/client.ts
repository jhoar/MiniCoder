import Database from 'better-sqlite3';
import type { DbClient, TxClient } from '@minicoder/core';

class SqliteTxClient implements TxClient {
  constructor(private readonly db: Database.Database) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const stmt = this.db.prepare(sql);
    stmt.run(...params);
  }
}

export class SqliteDbClient implements DbClient {
  constructor(private readonly db: Database.Database) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const stmt = this.db.prepare(sql);
    stmt.run(...params);
  }

  // Uses explicit BEGIN/COMMIT/ROLLBACK so the transaction remains open while
  // the async callback awaits. better-sqlite3's db.transaction() commits when
  // its synchronous wrapper returns — before any awaited work completes — so
  // that pattern is not safe for async callbacks.
  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    const tx = new SqliteTxClient(this.db);
    try {
      const result = await fn(tx);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
