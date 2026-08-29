import { createTestDb } from '@minicoder/testing';
import type { DbClient } from '@minicoder/core';
import { UserRole } from '@minicoder/core';
import { buildApp } from './app.js';
import { ApiKeyProvider } from './auth/api-key-provider.js';
import type { TaskTriggerClient } from './commands/task-trigger-routes.js';
import type { ScmClientResolver } from '@minicoder/triggerdev';

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
  resolveScmClient?: ScmClientResolver;
}) {
  const db = createTestDb() as unknown as DbClient;
  const app = await buildApp({
    db,
    apiKeyProvider: testApiKeyProvider(),
    webhookSecrets: ['test-webhook-secret'],
    giteaWebhookSecrets: ['test-gitea-webhook-secret'],
    gitlabWebhookSecrets: ['test-gitlab-webhook-secret'],
    taskTriggerClient: opts?.taskTriggerClient,
    resolveScmClient: opts?.resolveScmClient,
  });
  return { app, db };
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Seeds a plan + feature request + feature run parked at `human_required`, for the whoami-
 * adjacent Phase 14 read models (`/human-required-items`, `/triggerdev-runs`). */
export async function seedHumanRequiredFeatureRun(
  db: DbClient,
  projectId: string,
): Promise<{ featureRunId: string; featureRequestId: string }> {
  const now = new Date().toISOString();
  const planId = generateId();
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, state, title, version, created_at, updated_at)
     VALUES (?, ?, 'activated_for_execution', 'Test Plan', 1, ?, ?)`,
    [planId, projectId, now, now],
  );
  const featureRequestId = generateId();
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Test Feature', 'A test feature.', 'feature', 1, 'approved_pending_execution', 0, 1, ?, ?)`,
    [featureRequestId, planId, projectId, now, now],
  );
  const featureRunId = generateId();
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
     VALUES (?, ?, 1, 'human_required', 1, ?, ?)`,
    [featureRunId, featureRequestId, now, now],
  );
  return { featureRunId, featureRequestId };
}

/** Seeds a `disagreement_records` row against the given feature run, for `/disagreements`
 * read-model tests (issue #63's feature_request_id/project_id resolution). */
export async function seedDisagreement(
  db: DbClient,
  opts: { featureRunId: string; state?: string },
): Promise<{ disagreementId: string }> {
  const now = new Date().toISOString();
  const disagreementId = generateId();
  await db.execute(
    `INSERT INTO disagreement_records (id, feature_run_id, review_cycle, state, version, created_at, updated_at)
     VALUES (?, ?, 1, ?, 1, ?, ?)`,
    [disagreementId, opts.featureRunId, opts.state ?? 'open', now, now],
  );
  return { disagreementId };
}

/** Seeds a `triggerdev_runs` row for `/triggerdev-runs` read-model tests. */
export async function seedTriggerdevRun(
  db: DbClient,
  opts: { projectId: string; featureRunId?: string; status?: string },
): Promise<{ id: string }> {
  const now = new Date().toISOString();
  const id = generateId();
  await db.execute(
    `INSERT INTO triggerdev_runs (id, triggerdev_run_id, triggerdev_task_id, triggerdev_status, project_id, linked_feature_run_id, last_seen_at, version, created_at, updated_at)
     VALUES (?, ?, 'run-coder', ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      `td-${id}`,
      opts.status ?? 'running',
      opts.projectId,
      opts.featureRunId ?? null,
      now,
      now,
      now,
    ],
  );
  return { id };
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
