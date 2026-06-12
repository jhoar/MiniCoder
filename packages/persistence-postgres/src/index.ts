import { Pool } from 'pg';
import type { PersistenceBackend, DbClient } from '@minicoder/core';
import { PostgresDbClient } from './client.js';

export interface PostgresBackendOptions {
  connectionString: string;
  maxConnections?: number;
}

export class PostgresPersistenceBackend implements PersistenceBackend {
  readonly dialect = 'postgres' as const;
  private readonly pool: Pool;

  constructor(options: PostgresBackendOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
    });
  }

  async connect(): Promise<DbClient> {
    const client = await this.pool.connect();
    return new PostgresDbClient(client);
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

export { PostgresDbClient } from './client.js';
