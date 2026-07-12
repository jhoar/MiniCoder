export type Dialect = 'sqlite' | 'postgres';

export interface TxClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  executeAffected(sql: string, params?: unknown[]): Promise<number>;
}

export interface TransactionOptions {
  /** `'serializable'` requests PostgreSQL's `SERIALIZABLE` isolation (SSI) for this transaction.
   * PostgreSQL's serializable-snapshot-isolation machinery detects a dangerous read/write
   * conflict between this transaction and any OTHER transaction that is ALSO running at
   * `SERIALIZABLE` and touches the same rows — it does NOT protect against a concurrent writer
   * running at a weaker isolation level (the default), since that writer never participates in
   * SSI's dependency tracking at all. Requesting `'serializable'` on only one side of an
   * interaction is a real, meaningful safety improvement for races AMONG invocations of that same
   * transaction, but is not by itself a guarantee against every possible concurrent writer unless
   * those writers also opt into `SERIALIZABLE` (see `MarkImplementationCompleteHandler`'s doc
   * comment for a worked example of this exact tradeoff). On conflict, one of the participating
   * transactions fails at `COMMIT` with a `SerializationFailureError`; the caller is expected to
   * retry the whole transaction function from scratch (which naturally re-reads current state). A
   * no-op on the SQLite persistence backend — its synchronous, single-writer, whole-database-locked
   * transaction model already provides full serializability for a single-process connection, so
   * there is no weaker isolation level to escape from. */
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
