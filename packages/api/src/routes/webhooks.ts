/**
 * Mounts the existing GitHub webhook receiver (`packages/github/src/webhook-app.ts`) inside the
 * full Orchestrator API instead of re-implementing it (that module's own doc comment: "Phase 13
 * mounts `registerGithubWebhookRoute()` inside the full API instead of re-implementing this
 * handler"). This route is exempt from the API-key auth hook (see `auth/middleware.ts`) — it
 * authenticates via GitHub's HMAC webhook signature instead.
 *
 * Also mounts the Gitea webhook receiver (`packages/gitea/src/webhook-app.ts`, docs/06 §Phase 18
 * Stage 3) the same way — but only when `giteaWebhookSecrets` is supplied. Unlike GitHub, Gitea is
 * a staged/optional provider (docs/06 §Phase 18): a deployment with no Gitea-linked repository has
 * no reason to expose `/webhooks/gitea` at all, so this route is opt-in rather than always-on.
 */
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import { registerGithubWebhookRoute, addRawBodyCapture } from '@minicoder/github';
import { registerGiteaWebhookRoute } from '@minicoder/gitea';

export interface WebhookRouteDeps {
  db: DbClient;
  webhookSecrets: string[];
  giteaWebhookSecrets?: string[];
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  deps: WebhookRouteDeps,
): Promise<void> {
  // A single raw-body content-type parser serves both routes below — Fastify only allows one
  // parser per content type per app instance, so `@minicoder/gitea`'s own identical
  // `addRawBodyCapture` (used by its standalone `createGiteaWebhookApp()`) must NOT also be called
  // here, or registration would throw.
  addRawBodyCapture(app);
  await registerGithubWebhookRoute(app, { db: deps.db, secrets: deps.webhookSecrets });
  if (deps.giteaWebhookSecrets && deps.giteaWebhookSecrets.length > 0) {
    await registerGiteaWebhookRoute(app, { db: deps.db, secrets: deps.giteaWebhookSecrets });
  }
}
