import { createTestDb } from '@minicoder/testing';
import type { DbClient } from '@minicoder/core';
import { UserRole } from '@minicoder/core';
import { buildApp } from './app.js';
import { ApiKeyProvider } from './auth/api-key-provider.js';
import type { TaskTriggerClient } from './commands/task-trigger-routes.js';
import type { GithubClientFactory } from './commands/merge-if-ready-route.js';

export const TEST_OPERATOR_KEY = 'test-operator-key';
export const TEST_APPROVER_KEY = 'test-approver-key';
export const TEST_VIEWER_KEY = 'test-viewer-key';
export const TEST_ADMIN_KEY = 'test-admin-key';

export function testApiKeyProvider(): ApiKeyProvider {
  return new ApiKeyProvider([
    { key: TEST_OPERATOR_KEY, id: 'test-operator', role: UserRole.OPERATOR, actorKind: 'human' },
    { key: TEST_APPROVER_KEY, id: 'test-approver', role: UserRole.APPROVER, actorKind: 'human' },
    { key: TEST_VIEWER_KEY, id: 'test-viewer', role: UserRole.VIEWER, actorKind: 'human' },
    { key: TEST_ADMIN_KEY, id: 'test-admin', role: UserRole.ADMIN, actorKind: 'system' },
  ]);
}

export async function buildTestApp(opts?: {
  taskTriggerClient?: TaskTriggerClient;
  githubClientFactory?: GithubClientFactory;
}) {
  const db = createTestDb() as unknown as DbClient;
  const app = await buildApp({
    db,
    apiKeyProvider: testApiKeyProvider(),
    webhookSecrets: ['test-webhook-secret'],
    taskTriggerClient: opts?.taskTriggerClient,
    githubClientFactory: opts?.githubClientFactory,
  });
  return { app, db };
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function seedProjectWithWorkflowState(
  db: DbClient,
  opts: { automationState?: string } = {},
): Promise<{ projectId: string }> {
  const projectId = generateId();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO projects (id, name, description, state, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'active', 1, ?, ?)`,
    [projectId, `Test Project ${projectId}`, now, now],
  );
  await db.execute(
    `INSERT INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 1, ?, ?)`,
    [generateId(), projectId, opts.automationState ?? 'running', now, now],
  );
  return { projectId };
}
