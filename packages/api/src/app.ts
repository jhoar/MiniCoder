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
import { registerMergeIfReadyRoute } from './commands/merge-if-ready-route.js';
import { registerFinalizeIfGithubMergedRoute } from './commands/finalize-if-github-merged-route.js';
import {
  registerTaskTriggerRoutes,
  unconfiguredTaskTriggerClient,
  type TaskTriggerClient,
} from './commands/task-trigger-routes.js';
import { registerDiagnosticsRoutes } from './commands/diagnostics-routes.js';
import { registerRepairDesignDocumentBindingRoute } from './commands/repair-design-document-binding-route.js';
import type { ScmClientResolver } from '@minicoder/triggerdev';

export interface BuildAppOptions {
  db: DbClient;
  apiKeyProvider: ApiKeyProvider;
  webhookSecrets: string[];
  /** Opt-in — omit to leave `/webhooks/gitea` unmounted (docs/06 §Phase 18 Stages 3–4). */
  giteaWebhookSecrets?: string[];
  /** Opt-in — omit to leave `/webhooks/gitlab` unmounted (docs/06 §Phase 18 Stages 3–4). */
  gitlabWebhookSecrets?: string[];
  /** Stage 6 write-pipeline follow-up (docs/06 §Phase 18): resolves the correct `ScmClient`
   * implementation/credential per repository's own `provider`/`base_url`, instead of
   * unconditionally constructing `OctokitGitHubClient`. */
  resolveScmClient?: ScmClientResolver;
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
  registerMergeIfReadyRoute(app, { db: opts.db, resolveScmClient: opts.resolveScmClient });
  registerFinalizeIfGithubMergedRoute(app, {
    db: opts.db,
    resolveScmClient: opts.resolveScmClient,
  });
  registerTaskTriggerRoutes(app, {
    taskTriggerClient: opts.taskTriggerClient ?? unconfiguredTaskTriggerClient(),
  });
  registerDiagnosticsRoutes(app, { db: opts.db });
  registerRepairDesignDocumentBindingRoute(app, { db: opts.db });

  return app;
}
