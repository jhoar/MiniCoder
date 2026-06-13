export type Dialect = 'sqlite' | 'postgres';

export interface TxClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  executeAffected(sql: string, params?: unknown[]): Promise<number>;
}

export interface DbClient extends TxClient {
  transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
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
