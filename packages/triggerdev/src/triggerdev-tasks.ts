/**
 * Trigger.dev task registration entry point.
 *
 * Registers all 9 canonical tasks with the Trigger.dev runtime. Each task is a
 * thin wrapper that handles DB lifecycle tracking (linkRunToDb / updateRunStatus)
 * then delegates to the business-logic runImpl. No business rules live here.
 *
 * Fitness tests enforce:
 *   - No state machine imports
 *   - No domain entity mutations outside the command interface
 *   - No secrets in task payloads (RF-12)
 */

import { task } from '@trigger.dev/sdk/v3';
import { createDbClientFromEnv } from './db.js';
import { linkRunToDb, updateRunStatus } from './metadata.js';

import { runImpl as runPlanningReadiness } from './tasks/planning-readiness-assessment.js';
import { runImpl as runStartClarification } from './tasks/start-clarification.js';
import { runImpl as runGeneratePlan } from './tasks/generate-implementation-plan.js';
import { runImpl as runGenerateBacklog } from './tasks/generate-feature-backlog.js';
import { runImpl as runActivateBacklog } from './tasks/activate-approved-backlog.js';
import { runImpl as runStartNextFeature } from './tasks/start-next-feature.js';
import { runImpl as runGithubReconciliation } from './tasks/github-reconciliation.js';
import { runImpl as runExportPlan } from './tasks/export-plan.js';
import { runImpl as runExportBacklog } from './tasks/export-backlog.js';

import type { PlanningReadinessPayload } from './tasks/planning-readiness-assessment.js';
import type { StartClarificationPayload } from './tasks/start-clarification.js';
import type { GenerateImplementationPlanPayload } from './tasks/generate-implementation-plan.js';
import type { GenerateFeatureBacklogPayload } from './tasks/generate-feature-backlog.js';
import type { ActivateApprovedBacklogPayload } from './tasks/activate-approved-backlog.js';
import type { StartNextFeaturePayload } from './tasks/start-next-feature.js';
import type { GithubReconciliationPayload } from './tasks/github-reconciliation.js';
import type { ExportPlanPayload } from './tasks/export-plan.js';
import type { ExportBacklogPayload } from './tasks/export-backlog.js';

const RETRY_CONFIG = {
  maxAttempts: 3,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 30_000,
} as const;

function makeTaskRunner<P extends { projectId?: string }, R>(
  taskId: string,
  impl: (payload: P) => Promise<R>,
) {
  return async (payload: P, ctx: { run: { id: string } }): Promise<R> => {
    const db = await createDbClientFromEnv();
    await linkRunToDb(db, {
      triggerdevRunId: ctx.run.id,
      triggerdevTaskId: taskId,
      triggerdevStatus: 'running',
      projectId: payload.projectId,
    });
    let result: R;
    try {
      result = await impl(payload);
      await updateRunStatus(db, ctx.run.id, 'completed');
    } catch (err) {
      await updateRunStatus(db, ctx.run.id, 'failed');
      throw err;
    } finally {
      await db.close();
    }
    return result;
  };
}

export const planningReadinessAssessmentTask = task({
  id: 'planning-readiness-assessment',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: async (payload: PlanningReadinessPayload, { ctx }) =>
    makeTaskRunner('planning-readiness-assessment', runPlanningReadiness)(payload, ctx),
});

export const startClarificationTask = task({
  id: 'start-clarification',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: async (payload: StartClarificationPayload, { ctx }) =>
    makeTaskRunner('start-clarification', runStartClarification)(payload, ctx),
});

export const generateImplementationPlanTask = task({
  id: 'generate-implementation-plan',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: async (payload: GenerateImplementationPlanPayload, { ctx }) =>
    makeTaskRunner('generate-implementation-plan', runGeneratePlan)(payload, ctx),
});

export const generateFeatureBacklogTask = task({
  id: 'generate-feature-backlog',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: async (payload: GenerateFeatureBacklogPayload, { ctx }) =>
    makeTaskRunner('generate-feature-backlog', runGenerateBacklog)(payload, ctx),
});

export const activateApprovedBacklogTask = task({
  id: 'activate-approved-backlog',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: async (payload: ActivateApprovedBacklogPayload, { ctx }) =>
    makeTaskRunner('activate-approved-backlog', runActivateBacklog)(payload, ctx),
});

export const startNextFeatureTask = task({
  id: 'start-next-feature',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: async (payload: StartNextFeaturePayload, { ctx }) =>
    makeTaskRunner('start-next-feature', runStartNextFeature)(payload, ctx),
});

export const githubReconciliationTask = task({
  id: 'github-reconciliation',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: async (payload: GithubReconciliationPayload, { ctx }) =>
    makeTaskRunner('github-reconciliation', runGithubReconciliation)(payload, ctx),
});

export const exportPlanTask = task({
  id: 'export-plan',
  queue: { concurrencyLimit: 5 },
  retry: RETRY_CONFIG,
  run: async (payload: ExportPlanPayload, { ctx }) =>
    makeTaskRunner('export-plan', runExportPlan)(payload, ctx),
});

export const exportBacklogTask = task({
  id: 'export-backlog',
  queue: { concurrencyLimit: 5 },
  retry: RETRY_CONFIG,
  run: async (payload: ExportBacklogPayload, { ctx }) =>
    makeTaskRunner('export-backlog', runExportBacklog)(payload, ctx),
});

export { ALL_TASK_IDS } from './task-ids.js';
export type { TaskId } from './task-ids.js';
