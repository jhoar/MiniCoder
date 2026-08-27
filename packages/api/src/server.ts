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
  return app.listen({ port: opts.port, host: opts.host });
}
