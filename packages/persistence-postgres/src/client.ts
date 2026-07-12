import type { PoolClient } from 'pg';
import type { DbClient, TxClient, TransactionOptions } from '@minicoder/core';
import { RollbackFailedError, SerializationFailureError } from '@minicoder/core';

const POSTGRES_SERIALIZATION_FAILURE_SQLSTATE = '40001';

function isSerializationFailure(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === POSTGRES_SERIALIZATION_FAILURE_SQLSTATE
  );
}

const TX_EXPIRED_MSG = 'TxClient has expired: the transaction has already ended.';

// Convert SQLite-style ? placeholders to PostgreSQL-style $1, $2, ... positional params.
function convertPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

class PostgresTxClient implements TxClient {
  private invalidated = false;

  constructor(private readonly client: PoolClient) {}

  invalidate(): void {
    this.invalidated = true;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.invalidated) throw new Error(TX_EXPIRED_MSG);
    const result = await this.client.query(convertPlaceholders(sql), params);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (this.invalidated) throw new Error(TX_EXPIRED_MSG);
    await this.client.query(convertPlaceholders(sql), params);
  }

  async executeAffected(sql: string, params: unknown[] = []): Promise<number> {
    if (this.invalidated) throw new Error(TX_EXPIRED_MSG);
    const result = await this.client.query(convertPlaceholders(sql), params);
    return result.rowCount ?? 0;
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
    const result = await this.client.query(convertPlaceholders(sql), params);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (this.dead) throw new Error(DEAD_MSG);
    if (this.inTransaction) throw new Error(TX_ACTIVE_MSG.replace('%s', 'execute'));
    await this.client.query(convertPlaceholders(sql), params);
  }

  async executeAffected(sql: string, params: unknown[] = []): Promise<number> {
    if (this.dead) throw new Error(DEAD_MSG);
    if (this.inTransaction) throw new Error(TX_ACTIVE_MSG.replace('%s', 'executeAffected'));
    const result = await this.client.query(convertPlaceholders(sql), params);
    return result.rowCount ?? 0;
  }

  async transaction<T>(fn: (tx: TxClient) => Promise<T>, opts?: TransactionOptions): Promise<T> {
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
      if (opts?.isolationLevel === 'serializable') {
        await this.client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      }
      const result = await fn(tx);
      try {
        await this.client.query('COMMIT');
      } catch (commitErr) {
        // A serializable-isolation conflict can surface at COMMIT time (not just on an
        // individual statement) — translate it to a typed, caller-recognizable error rather
        // than a raw `pg` error with an opaque SQLSTATE.
        if (isSerializationFailure(commitErr)) {
          rollbackRequired = false; // COMMIT failing already ended the transaction server-side
          throw new SerializationFailureError(commitErr);
        }
        throw commitErr;
      }
      rollbackRequired = false;
      return result;
    } catch (err) {
      const translated = isSerializationFailure(err) ? new SerializationFailureError(err) : err;
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
          throw new RollbackFailedError(translated, rollbackErr);
        }
      } else if (!(translated instanceof SerializationFailureError)) {
        // BEGIN itself failed — transport may have left connection state unknown.
        // Discard the connection so the pool doesn't hand it to another caller.
        this.dead = true;
        try {
          this.client.release(err as Error);
        } catch {
          // ignore
        }
      }
      throw translated;
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
