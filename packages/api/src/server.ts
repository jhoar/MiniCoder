/**
 * Standalone entrypoint for `minicoder api serve` (see `packages/cli/src/commands/api.ts`).
 */
import { createDbClientFromEnv } from '@minicoder/triggerdev';
import { ApiKeyProvider } from './auth/api-key-provider.js';
import { buildApp } from './app.js';

export interface ServeOptions {
  port: number;
  host: string;
}

export async function serve(opts: ServeOptions): Promise<string> {
  const db = await createDbClientFromEnv();
  const apiKeyProvider = ApiKeyProvider.fromEnv();

  const secret = process.env['GITHUB_WEBHOOK_SECRET'];
  if (!secret) {
    throw new Error('GITHUB_WEBHOOK_SECRET must be set to run minicoder api serve.');
  }
  const previousSecret = process.env['GITHUB_WEBHOOK_SECRET_PREVIOUS'];
  const webhookSecrets = previousSecret ? [secret, previousSecret] : [secret];

  const app = await buildApp({ db, apiKeyProvider, webhookSecrets });
  return app.listen({ port: opts.port, host: opts.host });
}
