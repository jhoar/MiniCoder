/**
 * End-to-end proof that `@minicoder/tui`'s `ApiClient` really talks to a live Orchestrator API
 * process over HTTP — the "runnable demo scenario" this phase's Definition of Done requires,
 * automated rather than a manual-only runbook step. Boots the real `buildApp()` (packages/api)
 * against a throwaway in-memory SQLite DB, listens on an ephemeral port, and drives the client
 * against it exactly as `packages/cli`'s Phase 14 commands do.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb } from '@minicoder/testing';
import { buildApp, ApiKeyProvider } from '@minicoder/api';
import { UserRole } from '@minicoder/core';
import { ApiClient } from './client/api-client.js';

const OPERATOR_KEY = 'e2e-operator-key';

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
    [projectId, 'E2E Test Project', now, now],
  );
  await db.execute(
    `INSERT INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'running', 1, ?, ?)`,
    [generateId(), projectId, now, now],
  );

  const apiKeyProvider = new ApiKeyProvider([
    { key: OPERATOR_KEY, id: 'e2e-operator', role: UserRole.OPERATOR, actorKind: 'human' },
  ]);
  const app = await buildApp({
    db,
    apiKeyProvider,
    webhookSecrets: ['e2e-webhook-secret'],
  });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, baseUrl: address, projectId };
}

describe('tui e2e: ApiClient against a live Orchestrator API', () => {
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
    expect(whoami).toEqual({ id: 'e2e-operator', role: 'operator', actorKind: 'human' });

    const status = await client.getStatus(started.projectId);
    expect(status.project?.name).toBe('E2E Test Project');
    expect(status.workflowState).toMatchObject({ automation_state: 'running', version: 1 });

    const features = await client.listFeatures(started.projectId);
    expect(features.items).toEqual([]);
  });

  it('pauses and resumes automation end to end, using the version from /status', async () => {
    const started = await startTestServer();
    app = started.app;
    const client = new ApiClient({ baseUrl: started.baseUrl, apiKey: OPERATOR_KEY });

    const before = await client.getStatus(started.projectId);
    const version = before.workflowState!.version;

    const paused = await client.pauseAutomation(
      started.projectId,
      version,
      `e2e-pause:${started.projectId}:${version}`,
    );
    expect(paused.resulting_state).toBe('paused_by_operator');

    const afterPause = await client.getStatus(started.projectId);
    expect(afterPause.workflowState).toMatchObject({ automation_state: 'paused_by_operator' });

    const resumed = await client.resumeAutomation(
      started.projectId,
      afterPause.workflowState!.version,
      `e2e-resume:${started.projectId}:${afterPause.workflowState!.version}`,
    );
    expect(resumed.resulting_state).toBe('running');
  });

  it('surfaces a 404 as a typed ApiError for an unknown feature run', async () => {
    const started = await startTestServer();
    app = started.app;
    const client = new ApiClient({ baseUrl: started.baseUrl, apiKey: OPERATOR_KEY });

    await expect(client.getActiveFeature('does-not-exist')).rejects.toMatchObject({
      status: 404,
    });
  });
});
