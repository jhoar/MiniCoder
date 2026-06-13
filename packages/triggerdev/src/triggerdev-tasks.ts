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
import { z } from 'zod';
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

import {
  PlanningReadinessPayload as PlanningReadinessSchema,
  StartClarificationPayload as StartClarificationSchema,
  GenerateImplementationPlanPayload as GenerateImplementationPlanSchema,
  GenerateFeatureBacklogPayload as GenerateFeatureBacklogSchema,
  ActivateApprovedBacklogPayload as ActivateApprovedBacklogSchema,
  StartNextFeaturePayload as StartNextFeatureSchema,
  GithubReconciliationPayload as GithubReconciliationSchema,
  ExportPlanPayload as ExportPlanSchema,
  ExportBacklogPayload as ExportBacklogSchema,
} from './tasks/types.js';

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
  schema: z.ZodType<P>,
  impl: (payload: P) => Promise<R>,
) {
  return async (rawPayload: unknown, { ctx }: { ctx: { run: { id: string } } }): Promise<R> => {
    // Validate payload at the task boundary; invalid payloads are rejected before any DB write.
    const payload = schema.parse(rawPayload);
    const db = await createDbClientFromEnv();
    try {
      // Upsert: idempotent on retry — same run.id resets status to 'running'.
      await linkRunToDb(db, {
        triggerdevRunId: ctx.run.id,
        triggerdevTaskId: taskId,
        triggerdevStatus: 'running',
        projectId: payload.projectId,
      });
      let result: R;
      try {
        result = await impl(payload);
        await updateRunStatus(db, ctx.run.id, 'succeeded');
      } catch (err) {
        await updateRunStatus(db, ctx.run.id, 'failed');
        throw err;
      }
      return result;
    } finally {
      await db.close();
    }
  };
}

export const planningReadinessAssessmentTask = task({
  id: 'planning-readiness-assessment',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('planning-readiness-assessment', PlanningReadinessSchema, runPlanningReadiness),
});

export const startClarificationTask = task({
  id: 'start-clarification',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('start-clarification', StartClarificationSchema, runStartClarification),
});

export const generateImplementationPlanTask = task({
  id: 'generate-implementation-plan',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('generate-implementation-plan', GenerateImplementationPlanSchema, runGeneratePlan),
});

export const generateFeatureBacklogTask = task({
  id: 'generate-feature-backlog',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('generate-feature-backlog', GenerateFeatureBacklogSchema, runGenerateBacklog),
});

export const activateApprovedBacklogTask = task({
  id: 'activate-approved-backlog',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('activate-approved-backlog', ActivateApprovedBacklogSchema, runActivateBacklog),
});

export const startNextFeatureTask = task({
  id: 'start-next-feature',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('start-next-feature', StartNextFeatureSchema, runStartNextFeature),
});

export const githubReconciliationTask = task({
  id: 'github-reconciliation',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('github-reconciliation', GithubReconciliationSchema, runGithubReconciliation),
});

export const exportPlanTask = task({
  id: 'export-plan',
  queue: { concurrencyLimit: 5 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('export-plan', ExportPlanSchema, runExportPlan),
});

export const exportBacklogTask = task({
  id: 'export-backlog',
  queue: { concurrencyLimit: 5 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('export-backlog', ExportBacklogSchema, runExportBacklog),
});

export { ALL_TASK_IDS } from './task-ids.js';
export type { TaskId } from './task-ids.js';
