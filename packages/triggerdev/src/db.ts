import type { DbClient } from '@minicoder/core';

export async function createDbClientFromEnv(): Promise<DbClient> {
  const dialect = process.env['DB_DIALECT'] ?? 'sqlite';

  if (dialect === 'postgres') {
    const { PostgresPersistenceBackend } = await import('@minicoder/persistence-postgres');
    const url = process.env['DB_URL'];
    if (!url) throw new Error('DB_URL is required when DB_DIALECT=postgres');
    const backend = new PostgresPersistenceBackend({ connectionString: url });
    return backend.connect();
  }

  const { SqlitePersistenceBackend } = await import('@minicoder/persistence-sqlite');
  const path = process.env['DB_PATH'] ?? './minicoder.db';
  const backend = new SqlitePersistenceBackend({ path });
  return backend.connect();
}
