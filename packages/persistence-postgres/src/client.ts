import type { PoolClient } from 'pg';
import type { DbClient, TxClient } from '@minicoder/core';
import { RollbackFailedError } from '@minicoder/core';

const TX_EXPIRED_MSG = 'TxClient has expired: the transaction has already ended.';

class PostgresTxClient implements TxClient {
  private invalidated = false;

  constructor(private readonly client: PoolClient) {}

  invalidate(): void {
    this.invalidated = true;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.invalidated) throw new Error(TX_EXPIRED_MSG);
    const result = await this.client.query(sql, params);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (this.invalidated) throw new Error(TX_EXPIRED_MSG);
    await this.client.query(sql, params);
  }
}

const TX_ACTIVE_MSG =
  'Cannot call DbClient.%s() while a transaction is active; use the tx client passed to the transaction callback.';
const DEAD_MSG = 'This DbClient is unusable: connection is in an unknown state.';

export class PostgresDbClient implements DbClient {
  private inTransaction = false;
  private dead = false;

  constructor(private readonly client: PoolClient) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.dead) throw new Error(DEAD_MSG);
    if (this.inTransaction) throw new Error(TX_ACTIVE_MSG.replace('%s', 'query'));
    const result = await this.client.query(sql, params);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (this.dead) throw new Error(DEAD_MSG);
    if (this.inTransaction) throw new Error(TX_ACTIVE_MSG.replace('%s', 'execute'));
    await this.client.query(sql, params);
  }

  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    if (this.dead) throw new Error(DEAD_MSG);
    if (this.inTransaction) throw new Error('Nested transactions are not supported.');
    // Flag is set BEFORE awaiting BEGIN so no concurrent outer operation can
    // slip through the async window between BEGIN completing and the flag update.
    this.inTransaction = true;
    let rollbackRequired = false;
    const tx = new PostgresTxClient(this.client);
    try {
      await this.client.query('BEGIN');
      rollbackRequired = true;
      const result = await fn(tx);
      await this.client.query('COMMIT');
      rollbackRequired = false;
      return result;
    } catch (err) {
      if (rollbackRequired) {
        try {
          await this.client.query('ROLLBACK');
        } catch (rollbackErr) {
          // ROLLBACK failed — connection is in unknown state. Mark dead, release
          // the pool connection signalling the error so pg can discard it, and
          // surface both errors to the caller.
          this.dead = true;
          try {
            this.client.release(rollbackErr as Error);
          } catch {
            // release itself failing is ignored; the connection is gone either way
          }
          throw new RollbackFailedError(err, rollbackErr);
        }
      } else {
        // BEGIN itself failed — transport may have left connection state unknown.
        // Discard the connection so the pool doesn't hand it to another caller.
        this.dead = true;
        try {
          this.client.release(err as Error);
        } catch {
          // ignore
        }
      }
      throw err;
    } finally {
      this.inTransaction = false;
      tx.invalidate();
    }
  }

  async close(): Promise<void> {
    // If dead, release(error) was already called — don't release again.
    if (!this.dead) {
      this.client.release();
    }
  }
}
