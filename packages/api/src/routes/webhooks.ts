/**
 * Mounts the existing GitHub webhook receiver (`packages/github/src/webhook-app.ts`) inside the
 * full Orchestrator API instead of re-implementing it (that module's own doc comment: "Phase 13
 * mounts `registerGithubWebhookRoute()` inside the full API instead of re-implementing this
 * handler"). This route is exempt from the API-key auth hook (see `auth/middleware.ts`) — it
 * authenticates via GitHub's HMAC webhook signature instead.
 *
 * Also mounts the Gitea webhook receiver (`packages/gitea/src/webhook-app.ts`, docs/06 §Phase 18
 * Stage 3) and the GitLab webhook receiver (`packages/gitlab/src/webhook-app.ts`, Stage 4) the
 * same way — but only when their respective secrets are supplied. Unlike GitHub, both are
 * staged/optional providers (docs/06 §Phase 18): a deployment with no repository linked to them
 * has no reason to expose their webhook routes at all, so both are opt-in rather than always-on.
 */
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import { registerGithubWebhookRoute, addRawBodyCapture } from '@minicoder/github';
import { registerGiteaWebhookRoute } from '@minicoder/gitea';
import { registerGitlabWebhookRoute } from '@minicoder/gitlab';

export interface WebhookRouteDeps {
  db: DbClient;
  webhookSecrets: string[];
  giteaWebhookSecrets?: string[];
  gitlabWebhookSecrets?: string[];
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  deps: WebhookRouteDeps,
): Promise<void> {
  // A single raw-body content-type parser serves all three routes below — Fastify only allows one
  // parser per content type per app instance, so `@minicoder/gitea`'s/`@minicoder/gitlab`'s own
  // identical `addRawBodyCapture` (used by their standalone `create*WebhookApp()`s) must NOT also
  // be called here, or registration would throw.
  addRawBodyCapture(app);
  await registerGithubWebhookRoute(app, { db: deps.db, secrets: deps.webhookSecrets });
  if (deps.giteaWebhookSecrets && deps.giteaWebhookSecrets.length > 0) {
    await registerGiteaWebhookRoute(app, { db: deps.db, secrets: deps.giteaWebhookSecrets });
  }
  if (deps.gitlabWebhookSecrets && deps.gitlabWebhookSecrets.length > 0) {
    await registerGitlabWebhookRoute(app, { db: deps.db, secrets: deps.gitlabWebhookSecrets });
  }
}
