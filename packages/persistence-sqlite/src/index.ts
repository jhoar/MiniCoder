import Database from 'better-sqlite3';
import type { PersistenceBackend, DbClient } from '@minicoder/core';
import { SqliteDbClient } from './client.js';

export interface SqliteBackendOptions {
  path: string;
  foreignKeys?: boolean;
}

export class SqlitePersistenceBackend implements PersistenceBackend {
  readonly dialect = 'sqlite' as const;

  constructor(private readonly options: SqliteBackendOptions) {}

  async connect(): Promise<DbClient> {
    const db = new Database(this.options.path);

    // WAL mode for better concurrency
    db.pragma('journal_mode = WAL');
    // PR #75 review fix (HIGH-2 follow-up): without an explicit busy_timeout, SQLite's default
    // (0ms) makes a concurrent writer throw SQLITE_BUSY ("database is locked") immediately instead
    // of waiting briefly for the current writer to finish — a real problem now that
    // TaskQueueDispatcher opens many independent short-lived connections against the same file
    // (one per claim attempt, one per claimed task's execution), any of which can legitimately
    // contend for the write lock for a few milliseconds. 5s is generous enough to absorb that
    // without masking a genuinely stuck writer.
    db.pragma('busy_timeout = 5000');

    // Enforce foreign keys — SQLite disables them by default
    if (this.options.foreignKeys !== false) {
      db.pragma('foreign_keys = ON');
    }

    return new SqliteDbClient(db);
  }
}

export { SqliteDbClient } from './client.js';
