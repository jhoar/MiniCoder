import type { DbClient } from '@minicoder/core';

/**
 * Probes the triggerdev_runs table to verify migrations have been applied.
 * Called by createDbClientFromEnv() before returning the client so task containers
 * fail fast with an actionable message instead of a cryptic "no such table" error
 * deep inside linkRunToDb().
 */
export async function assertSchemaReady(db: DbClient): Promise<void> {
  try {
    await db.query('SELECT 1 FROM triggerdev_runs LIMIT 1', []);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('no such table') || // SQLite
      msg.includes('does not exist') // PostgreSQL: "relation ... does not exist"
    ) {
      throw new Error(
        'triggerdev_runs table not found in the configured database. ' +
          'Run migrations before starting tasks: minicoder db migrate\n' +
          'For self-hosted task containers, set DB_DIALECT and DB_PATH (SQLite) or ' +
          'DB_URL (PostgreSQL) to a migrated database.',
      );
    }
    throw err;
  }
}

export async function createDbClientFromEnv(): Promise<DbClient> {
  const dialect = process.env['DB_DIALECT'] ?? 'sqlite';

  let db: DbClient;
  if (dialect === 'postgres') {
    const { PostgresPersistenceBackend } = await import('@minicoder/persistence-postgres');
    const url = process.env['DB_URL'];
    if (!url) throw new Error('DB_URL is required when DB_DIALECT=postgres');
    const backend = new PostgresPersistenceBackend({ connectionString: url });
    db = await backend.connect();
  } else {
    const { SqlitePersistenceBackend } = await import('@minicoder/persistence-sqlite');
    const path = process.env['DB_PATH'] ?? './minicoder.db';
    const backend = new SqlitePersistenceBackend({ path });
    db = await backend.connect();
  }

  await assertSchemaReady(db);
  return db;
}
