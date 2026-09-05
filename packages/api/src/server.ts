/**
 * Standalone entrypoint for `minicoder api serve` (see `packages/cli/src/commands/api.ts`).
 */
import { createDbClientFromEnv } from '@minicoder/triggerdev';
import { ApiKeyProvider } from './auth/api-key-provider.js';
import { buildApp } from './app.js';
import { resolveDefaultTaskTriggerClient } from './default-task-trigger-client.js';

export interface ServeOptions {
  port: number;
  host: string;
}

/**
 * Reads a current+previous webhook-secret pair from the two named env vars (the shared rotation-
 * window shape every provider uses). Returns `undefined` when the primary var is unset — the
 * caller decides whether that's fatal (GitHub, required) or means "leave this provider's route
 * unmounted" (Gitea/GitLab, staged/optional — docs/06 §Phase 18).
 */
function resolveWebhookSecrets(envVar: string, previousEnvVar: string): string[] | undefined {
  const secret = process.env[envVar];
  if (!secret) return undefined;
  const previousSecret = process.env[previousEnvVar];
  return previousSecret ? [secret, previousSecret] : [secret];
}

export async function serve(opts: ServeOptions): Promise<string> {
  const db = await createDbClientFromEnv();
  const apiKeyProvider = ApiKeyProvider.fromEnv();

  const webhookSecrets = resolveWebhookSecrets(
    'GITHUB_WEBHOOK_SECRET',
    'GITHUB_WEBHOOK_SECRET_PREVIOUS',
  );
  if (!webhookSecrets) {
    throw new Error('GITHUB_WEBHOOK_SECRET must be set to run minicoder api serve.');
  }

  const giteaWebhookSecrets = resolveWebhookSecrets(
    'GITEA_WEBHOOK_SECRET',
    'GITEA_WEBHOOK_SECRET_PREVIOUS',
  );
  const gitlabWebhookSecrets = resolveWebhookSecrets(
    'GITLAB_WEBHOOK_SECRET',
    'GITLAB_WEBHOOK_SECRET_PREVIOUS',
  );

  const app = await buildApp({
    db,
    apiKeyProvider,
    webhookSecrets,
    giteaWebhookSecrets,
    gitlabWebhookSecrets,
    taskTriggerClient: resolveDefaultTaskTriggerClient(),
  });
  const address = await app.listen({ port: opts.port, host: opts.host });

  // A graceful shutdown matters beyond "don't drop an in-flight request": SQLite runs in WAL
  // mode (`packages/persistence-sqlite/src/index.ts`), so committed writes can sit in a
  // `data/minicoder.db-wal` side file until the last connection to it closes cleanly (or an
  // automatic checkpoint fires). Without this, `db.close()` was never called at all — Ctrl-C
  // killed the process directly, leaving the WAL un-checkpointed and making the main `.db` file
  // look like it's missing recent state to anything that reads it directly (a plain `sqlite3`
  // CLI, a DB browser, a naive backup script) instead of through this same connection, which
  // would transparently replay the WAL. Mirrors `minicoder tasks worker`'s existing
  // SIGINT/SIGTERM handling (`packages/cli/src/commands/tasks.ts`).
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`minicoder api serve: received ${signal}, shutting down...`);
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return address;
}
