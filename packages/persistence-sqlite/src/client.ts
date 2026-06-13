import Database from 'better-sqlite3';
import type { DbClient, TxClient } from '@minicoder/core';
import { RollbackFailedError } from '@minicoder/core';

const TX_EXPIRED_MSG = 'TxClient has expired: the transaction has already ended.';

class SqliteTxClient implements TxClient {
  private invalidated = false;

  constructor(private readonly db: Database.Database) {}

  invalidate(): void {
    this.invalidated = true;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.invalidated) throw new Error(TX_EXPIRED_MSG);
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (this.invalidated) throw new Error(TX_EXPIRED_MSG);
    const stmt = this.db.prepare(sql);
    stmt.run(...params);
  }

  async executeAffected(sql: string, params: unknown[] = []): Promise<number> {
    if (this.invalidated) throw new Error(TX_EXPIRED_MSG);
    const stmt = this.db.prepare(sql);
    return stmt.run(...params).changes;
  }
}

const TX_ACTIVE_MSG =
  'Cannot call DbClient.%s() while a transaction is active; use the tx client passed to the transaction callback.';
const DEAD_MSG = 'This DbClient is unusable: ROLLBACK failed on a previous transaction.';

export class SqliteDbClient implements DbClient {
  private inTransaction = false;
  private dead = false;

  constructor(private readonly db: Database.Database) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.dead) throw new Error(DEAD_MSG);
    if (this.inTransaction) throw new Error(TX_ACTIVE_MSG.replace('%s', 'query'));
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (this.dead) throw new Error(DEAD_MSG);
    if (this.inTransaction) throw new Error(TX_ACTIVE_MSG.replace('%s', 'execute'));
    const stmt = this.db.prepare(sql);
    stmt.run(...params);
  }

  async executeAffected(sql: string, params: unknown[] = []): Promise<number> {
    if (this.dead) throw new Error(DEAD_MSG);
    if (this.inTransaction) throw new Error(TX_ACTIVE_MSG.replace('%s', 'executeAffected'));
    const stmt = this.db.prepare(sql);
    return stmt.run(...params).changes;
  }

  // Uses explicit BEGIN/COMMIT/ROLLBACK so the transaction remains open while
  // the async callback awaits. better-sqlite3's db.transaction() commits when
  // its synchronous wrapper returns — before any awaited work completes — so
  // that pattern is not safe for async callbacks.
  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    if (this.dead) throw new Error(DEAD_MSG);
    if (this.inTransaction) throw new Error('Nested transactions are not supported.');
    let rollbackRequired = false;
    const tx = new SqliteTxClient(this.db);
    try {
      this.db.exec('BEGIN'); // flag stays false if this throws — client remains usable
      rollbackRequired = true;
      this.inTransaction = true;
      const result = await fn(tx);
      this.db.exec('COMMIT');
      rollbackRequired = false;
      return result;
    } catch (err) {
      if (rollbackRequired) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          // ROLLBACK failed — connection is in unknown state; mark dead so no
          // further operations are allowed, and surface both errors.
          this.dead = true;
          throw new RollbackFailedError(err, rollbackErr);
        }
      }
      throw err;
    } finally {
      this.inTransaction = false;
      tx.invalidate();
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
