import Fastify, { type FastifyInstance } from 'fastify';
import type { DbClient } from '@minicoder/core';
import { ApiKeyProvider } from './auth/api-key-provider.js';
import { registerAuthHook } from './auth/middleware.js';
import { registerOpenApiHooks } from './openapi/register-openapi-hooks.js';
import { toProblemDetails } from './errors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerAllReadRoutes } from './routes/reads/index.js';
import { buildCommandRegistry } from './commands/registry.js';
import { registerGenericDispatchRoute } from './commands/generic-dispatch-route.js';
import {
  registerMergeIfReadyRoute,
  type GithubClientFactory,
} from './commands/merge-if-ready-route.js';
import { registerFinalizeIfGithubMergedRoute } from './commands/finalize-if-github-merged-route.js';
import {
  registerTaskTriggerRoutes,
  unconfiguredTaskTriggerClient,
  type TaskTriggerClient,
} from './commands/task-trigger-routes.js';
import { registerDiagnosticsRoutes } from './commands/diagnostics-routes.js';

export interface BuildAppOptions {
  db: DbClient;
  apiKeyProvider: ApiKeyProvider;
  webhookSecrets: string[];
  /** Opt-in — Gitea is a staged provider (docs/06 §Phase 18); omit to leave `/webhooks/gitea` unmounted. */
  giteaWebhookSecrets?: string[];
  /** Opt-in — GitLab is a staged provider (docs/06 §Phase 18); omit to leave `/webhooks/gitlab` unmounted. */
  gitlabWebhookSecrets?: string[];
  githubClientFactory?: GithubClientFactory;
  taskTriggerClient?: TaskTriggerClient;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  registerOpenApiHooks(app);
  registerAuthHook(app, opts.apiKeyProvider);

  app.setErrorHandler((err, request, reply) => {
    const { status, body } = toProblemDetails(err, request.url);
    reply.code(status).type('application/problem+json').send(body);
  });

  registerHealthRoutes(app);
  await registerWebhookRoutes(app, {
    db: opts.db,
    webhookSecrets: opts.webhookSecrets,
    giteaWebhookSecrets: opts.giteaWebhookSecrets,
    gitlabWebhookSecrets: opts.gitlabWebhookSecrets,
  });
  registerAllReadRoutes(app, opts.db);

  const registry = buildCommandRegistry();
  registerGenericDispatchRoute(app, { db: opts.db, registry });
  registerMergeIfReadyRoute(app, { db: opts.db, githubClientFactory: opts.githubClientFactory });
  registerFinalizeIfGithubMergedRoute(app, {
    db: opts.db,
    githubClientFactory: opts.githubClientFactory,
  });
  registerTaskTriggerRoutes(app, {
    taskTriggerClient: opts.taskTriggerClient ?? unconfiguredTaskTriggerClient(),
  });
  registerDiagnosticsRoutes(app, { db: opts.db });

  return app;
}
