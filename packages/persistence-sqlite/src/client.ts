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
  private readonly txClient: SqliteTxClient;

  constructor(private readonly db: Database.Database) {
    this.txClient = new SqliteTxClient(db);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const stmt = this.db.prepare(sql);
    stmt.run(...params);
  }

  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    // better-sqlite3 transactions are synchronous under the hood; we wrap in a sync transaction
    // and await the async function inside it using a workaround pattern.
    let result: T;
    let error: unknown;
    let resolved = false;

    const transact = this.db.transaction(() => {
      // Run the async fn synchronously by executing it and storing the promise
      // This works because better-sqlite3 is synchronous — the fn must not actually be async
      // For truly async operations, use pg. For SQLite, fn should be sync-over-sync.
      const promise = fn(this.txClient);
      promise.then(
        (r) => {
          result = r;
          resolved = true;
        },
        (e: unknown) => {
          error = e;
          resolved = true;
        },
      );
      return promise;
    });

    // Execute the transaction — this blocks until the sync body runs
    // Note: SQLite transactions with async functions require careful usage.
    // The transaction wrapper here is for grouping; true async safety requires all
    // operations inside fn to be synchronous (as better-sqlite3 requires).
    await transact();

    if (!resolved) {
      throw new Error('Transaction function did not resolve synchronously');
    }
    if (error !== undefined) {
      throw error as Error;
    }
    return result!;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
