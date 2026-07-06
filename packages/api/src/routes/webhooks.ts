/**
 * Mounts the existing GitHub webhook receiver (`packages/github/src/webhook-app.ts`) inside the
 * full Orchestrator API instead of re-implementing it (that module's own doc comment: "Phase 13
 * mounts `registerGithubWebhookRoute()` inside the full API instead of re-implementing this
 * handler"). This route is exempt from the API-key auth hook (see `auth/middleware.ts`) — it
 * authenticates via GitHub's HMAC webhook signature instead.
 */
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import { registerGithubWebhookRoute, addRawBodyCapture } from '@minicoder/github';

export interface WebhookRouteDeps {
  db: DbClient;
  webhookSecrets: string[];
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  deps: WebhookRouteDeps,
): Promise<void> {
  addRawBodyCapture(app);
  await registerGithubWebhookRoute(app, { db: deps.db, secrets: deps.webhookSecrets });
}
