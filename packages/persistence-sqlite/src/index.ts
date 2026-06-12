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

    // Enforce foreign keys — SQLite disables them by default
    if (this.options.foreignKeys !== false) {
      db.pragma('foreign_keys = ON');
    }

    return new SqliteDbClient(db);
  }
}

export { SqliteDbClient } from './client.js';
