export type Dialect = 'sqlite' | 'postgres';

export interface TxClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  executeAffected(sql: string, params?: unknown[]): Promise<number>;
}

export interface TransactionOptions {
  /** `'serializable'` requests PostgreSQL's `SERIALIZABLE` isolation (SSI) for this transaction —
   * PostgreSQL's serializable-snapshot-isolation machinery then automatically detects a
   * dangerous read/write conflict against ANY concurrent transaction touching the rows this
   * transaction read, without requiring those other transactions to acquire any explicit lock or
   * participate in any shared fence. On conflict, one of the two transactions fails at `COMMIT`
   * with a `SerializationFailureError`; the caller is expected to retry the whole transaction
   * function from scratch (which naturally re-reads current state). A no-op on the SQLite
   * persistence backend — its synchronous, single-writer, whole-database-locked transaction model
   * already provides full serializability for a single-process connection, so there is no weaker
   * isolation level to escape from. */
  isolationLevel?: 'serializable';
}

export interface DbClient extends TxClient {
  transaction<T>(fn: (tx: TxClient) => Promise<T>, opts?: TransactionOptions): Promise<T>;
  close(): Promise<void>;
}

export interface PersistenceBackend {
  readonly dialect: Dialect;
  connect(): Promise<DbClient>;
}

export class OptimisticLockError extends Error {
  constructor(
    public readonly table: string,
    public readonly id: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Optimistic lock conflict on ${table} id=${id}: expected version ${expectedVersion}, got ${actualVersion}`,
    );
    this.name = 'OptimisticLockError';
  }
}

export class StaleFenceError extends Error {
  constructor(
    public readonly lockId: string,
    public readonly heldFence: number,
    public readonly currentFence: number,
  ) {
    super(`Stale fence token for lock ${lockId}: held=${heldFence}, current=${currentFence}`);
    this.name = 'StaleFenceError';
  }
}

export class SerializationFailureError extends Error {
  constructor(public readonly cause: unknown) {
    super(
      'PostgreSQL SERIALIZABLE transaction aborted due to a detected read/write conflict with ' +
        'a concurrent transaction (SQLSTATE 40001) — the caller should retry the whole ' +
        'transaction function.',
    );
    this.name = 'SerializationFailureError';
  }
}

export class RollbackFailedError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly rollbackError: unknown,
  ) {
    const orig = originalError instanceof Error ? originalError.message : String(originalError);
    super(
      `ROLLBACK failed after a transaction error; connection is no longer usable. Original error: ${orig}`,
    );
    this.name = 'RollbackFailedError';
  }
}
