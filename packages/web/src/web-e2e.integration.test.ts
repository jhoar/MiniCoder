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
  db: ReturnType<typeof createTestDb>;
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
  return { app, baseUrl: address, projectId, db };
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

  // Issue #66: the /costs page's Budget report section and the /features/[id] page's Timeline
  // section both call these two methods — prove they round-trip over real HTTP, not just against
  // a fake fetchImpl (api-client.test.ts already covers the fake-fetch shape).
  it('fetches an empty budget report for a project with no cost records yet', async () => {
    const started = await startTestServer();
    app = started.app;
    const client = new ApiClient({ baseUrl: started.baseUrl, apiKey: OPERATOR_KEY });

    const report = await client.getBudgetReport(started.projectId);
    expect(report).toMatchObject({
      projectId: started.projectId,
      windowDays: null,
      totalAmount: 0,
      recordCount: 0,
    });
    expect(report.byScope).toEqual([]);
  });

  it('fetches a feature-run timeline containing the recorded workflow events', async () => {
    const started = await startTestServer();
    app = started.app;
    const client = new ApiClient({ baseUrl: started.baseUrl, apiKey: OPERATOR_KEY });

    const featureRunId = generateId();
    const now = new Date().toISOString();
    const { db } = started;
    await db.execute(
      `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, ?, ?)`,
      [`plan-${featureRunId}`, started.projectId, now, now],
    );
    await db.execute(
      `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, 'approved', 0, 1, ?, ?)`,
      [`fr-${featureRunId}`, `plan-${featureRunId}`, started.projectId, now, now],
    );
    await db.execute(
      `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, 'coding', 1, ?, ?)`,
      [featureRunId, `fr-${featureRunId}`, now, now],
    );
    await db.execute(
      `INSERT INTO workflow_events (id, project_id, feature_run_id, event_type, from_state, to_state, actor, occurred_at, payload, payload_schema_version)
       VALUES (?, ?, ?, 'feature.selected', 'approved_pending_execution', 'selected', 'system', ?, '{}', '1')`,
      [generateId(), started.projectId, featureRunId, now],
    );

    const timeline = await client.getFeatureRunTimeline(featureRunId);
    expect(timeline.featureRunId).toBe(featureRunId);
    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0]).toMatchObject({ kind: 'workflow_event' });
  });
});
