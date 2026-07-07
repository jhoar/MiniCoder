/**
 * End-to-end proof that this package's `ApiClient` (`lib/api-client.ts`) really talks to a live
 * Orchestrator API process over HTTP — the "runnable demo scenario" this phase's Definition of
 * Done requires, automated rather than a manual-only runbook step. Direct structural port of
 * `packages/tui/src/tui-e2e.integration.test.ts`: boots the real `buildApp()` (packages/api)
 * against a throwaway in-memory SQLite DB, listens on an ephemeral port, and drives the client
 * against it exactly as a Server Component/Server Action in this package would.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb } from '@minicoder/testing';
import { buildApp, ApiKeyProvider } from '@minicoder/api';
import { UserRole } from '@minicoder/core';
import { ApiClient } from './lib/api-client';

const OPERATOR_KEY = 'e2e-web-operator-key';
const VIEWER_KEY = 'e2e-web-viewer-key';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function startTestServer(): Promise<{
  app: FastifyInstance;
  baseUrl: string;
  projectId: string;
}> {
  const db = createTestDb();
  const projectId = generateId();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO projects (id, name, description, state, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'active', 1, ?, ?)`,
    [projectId, 'Web E2E Test Project', now, now],
  );
  await db.execute(
    `INSERT INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'running', 1, ?, ?)`,
    [generateId(), projectId, now, now],
  );

  const apiKeyProvider = new ApiKeyProvider([
    { key: OPERATOR_KEY, id: 'e2e-web-operator', role: UserRole.OPERATOR, actorKind: 'human' },
    { key: VIEWER_KEY, id: 'e2e-web-viewer', role: UserRole.VIEWER, actorKind: 'human' },
  ]);
  const app = await buildApp({
    db,
    apiKeyProvider,
    webhookSecrets: ['e2e-web-webhook-secret'],
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, baseUrl: address, projectId };
}

describe('web e2e: ApiClient against a live Orchestrator API', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('fetches whoami and project status over real HTTP', async () => {
    const started = await startTestServer();
    app = started.app;
    const client = new ApiClient({ baseUrl: started.baseUrl, apiKey: OPERATOR_KEY });

    const whoami = await client.getWhoami();
    expect(whoami).toEqual({ id: 'e2e-web-operator', role: 'operator', actorKind: 'human' });

    const status = await client.getStatus(started.projectId);
    expect(status.project?.name).toBe('Web E2E Test Project');
    expect(status.workflowState).toMatchObject({ automation_state: 'running', version: 1 });

    const features = await client.listFeatures(started.projectId);
    expect(features.items).toEqual([]);
  });

  it('resolves the current project via listProjects for the project-switcher flow', async () => {
    const started = await startTestServer();
    app = started.app;
    const client = new ApiClient({ baseUrl: started.baseUrl, apiKey: OPERATOR_KEY });

    const projects = await client.listProjects({ limit: '10' });
    expect(projects.items.map((p) => p.id)).toContain(started.projectId);
  });

  it('surfaces a 403 as a typed ApiError for an operator-gated diagnostics call made with a viewer key', async () => {
    const started = await startTestServer();
    app = started.app;
    const client = new ApiClient({ baseUrl: started.baseUrl, apiKey: VIEWER_KEY });

    await expect(client.getDoctorStatus(started.projectId)).rejects.toMatchObject({ status: 403 });
  });

  it('surfaces a 404 as a typed ApiError for an unknown feature run', async () => {
    const started = await startTestServer();
    app = started.app;
    const client = new ApiClient({ baseUrl: started.baseUrl, apiKey: OPERATOR_KEY });

    await expect(client.getFeatureRun('does-not-exist')).rejects.toMatchObject({ status: 404 });
  });
});
