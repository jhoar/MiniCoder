/**
 * Trigger.dev task registration entry point.
 *
 * Registers all canonical tasks (see `ALL_TASK_IDS`) with the Trigger.dev runtime. Each task is a
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
import type { DbClient, PlannerAgentAdapter } from '@minicoder/core';
import { createDbClientFromEnv } from './db.js';
import { linkRunToDb, updateRunStatus } from './metadata.js';
import { requireNonBlankEnvVar } from './tasks/env.js';

import { runImpl as runIngestSpecification } from './tasks/ingest-specification.js';
import { runImpl as runPlanningReadiness } from './tasks/planning-readiness-assessment.js';
import { runImpl as runStartClarification } from './tasks/start-clarification.js';
import { runImpl as runRecordClarificationAnswer } from './tasks/record-clarification-answer.js';
import { runImpl as runCompleteClarification } from './tasks/complete-clarification.js';
import { runImpl as runGeneratePlan } from './tasks/generate-implementation-plan.js';
import { runImpl as runGenerateBacklog } from './tasks/generate-feature-backlog.js';
import { runImpl as runValidateBacklog } from './tasks/validate-backlog.js';
import { runImpl as runRequestPlanApproval } from './tasks/request-plan-approval.js';
import { runImpl as runActivateBacklog } from './tasks/activate-approved-backlog.js';
import { runImpl as runStartNextFeature } from './tasks/start-next-feature.js';
import { runImpl as runRunCoder } from './tasks/run-coder.js';
import { runImpl as runRunReview } from './tasks/run-review.js';
import { runImpl as runRunMergeGate } from './tasks/run-merge-gate.js';
import { runImpl as runGithubReconciliation } from './tasks/github-reconciliation.js';
import { runImpl as runExportPlan } from './tasks/export-plan.js';
import { runImpl as runExportBacklog } from './tasks/export-backlog.js';
import { runImpl as runImportBacklog } from './tasks/import-backlog.js';
import { runImpl as runRunDesignDoc } from './tasks/run-design-doc.js';

import {
  IngestSpecificationPayload as IngestSpecificationSchema,
  PlanningReadinessPayload as PlanningReadinessSchema,
  StartClarificationPayload as StartClarificationSchema,
  RecordClarificationAnswerPayload as RecordClarificationAnswerSchema,
  CompleteClarificationPayload as CompleteClarificationSchema,
  GenerateImplementationPlanPayload as GenerateImplementationPlanSchema,
  GenerateFeatureBacklogPayload as GenerateFeatureBacklogSchema,
  ValidateBacklogPayload as ValidateBacklogSchema,
  RequestPlanApprovalPayload as RequestPlanApprovalSchema,
  ActivateApprovedBacklogPayload as ActivateApprovedBacklogSchema,
  StartNextFeaturePayload as StartNextFeatureSchema,
  RunCoderPayload as RunCoderSchema,
  RunReviewPayload as RunReviewSchema,
  RunMergeGatePayload as RunMergeGateSchema,
  GithubReconciliationPayload as GithubReconciliationSchema,
  ExportPlanPayload as ExportPlanSchema,
  ExportBacklogPayload as ExportBacklogSchema,
  ImportBacklogPayload as ImportBacklogSchema,
  RunDesignDocPayload as RunDesignDocSchema,
} from './tasks/types.js';

const RETRY_CONFIG = {
  maxAttempts: 3,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 30_000,
} as const;

/**
 * Constructs the real reference `GenericLLMPlannerAdapter` (issue #32) from env config.
 * Deliberately reuses the same `CODE_GEN_BASE_URL`/`CODE_GEN_API_KEY`/`CODE_GEN_MODEL` env vars
 * `run-coder.ts`/`run-review.ts` already use — simpler than introducing a parallel `PLANNER_*` env
 * var family when the same OpenAI-compatible endpoint can serve all three roles. A deployment
 * wanting a distinct planner model/endpoint can still inject a custom `PlannerAgentAdapter`
 * directly (this resolver is only reached when no adapter is otherwise supplied).
 */
async function resolveDefaultPlannerAdapter(): Promise<PlannerAgentAdapter> {
  const codeGenBaseUrl = requireNonBlankEnvVar(
    'CODE_GEN_BASE_URL',
    'planning-readiness-assessment requires an OpenAI-compatible endpoint — see ' +
      'docs/07-security-and-secrets.md §3.',
  );
  const codeGenApiKey = requireNonBlankEnvVar(
    'CODE_GEN_API_KEY',
    'planning-readiness-assessment requires an OpenAI-compatible endpoint — see ' +
      'docs/07-security-and-secrets.md §3.',
  );
  const codeGenModel = requireNonBlankEnvVar(
    'CODE_GEN_MODEL',
    'planning-readiness-assessment requires an OpenAI-compatible endpoint — see ' +
      'docs/07-security-and-secrets.md §3.',
  );
  const { GenericLLMPlannerAdapter, HttpPlanProvider } =
    await import('@minicoder/adapters-planner');
  return new GenericLLMPlannerAdapter({
    planProvider: new HttpPlanProvider({
      baseUrl: codeGenBaseUrl,
      apiKey: codeGenApiKey,
      model: codeGenModel,
    }),
  });
}

function makeTaskRunner<P extends { projectId?: string }, R>(
  taskId: string,
  schema: z.ZodType<P, z.ZodTypeDef, unknown>,
  impl: (payload: P, db: DbClient) => Promise<R>,
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
        result = await impl(payload, db);
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

export const ingestSpecificationTask = task({
  id: 'ingest-specification',
  queue: { concurrencyLimit: 5 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('ingest-specification', IngestSpecificationSchema, runIngestSpecification),
});

export const planningReadinessAssessmentTask = task({
  id: 'planning-readiness-assessment',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner(
    'planning-readiness-assessment',
    PlanningReadinessSchema,
    async (payload, db) => runPlanningReadiness(payload, db, await resolveDefaultPlannerAdapter()),
  ),
});

export const startClarificationTask = task({
  id: 'start-clarification',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('start-clarification', StartClarificationSchema, runStartClarification),
});

export const recordClarificationAnswerTask = task({
  id: 'record-clarification-answer',
  queue: { concurrencyLimit: 5 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner(
    'record-clarification-answer',
    RecordClarificationAnswerSchema,
    runRecordClarificationAnswer,
  ),
});

export const completeClarificationTask = task({
  id: 'complete-clarification',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner(
    'complete-clarification',
    CompleteClarificationSchema,
    runCompleteClarification,
  ),
});

export const generateImplementationPlanTask = task({
  id: 'generate-implementation-plan',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner(
    'generate-implementation-plan',
    GenerateImplementationPlanSchema,
    runGeneratePlan,
  ),
});

export const generateFeatureBacklogTask = task({
  id: 'generate-feature-backlog',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('generate-feature-backlog', GenerateFeatureBacklogSchema, runGenerateBacklog),
});

export const validateBacklogTask = task({
  id: 'validate-backlog',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('validate-backlog', ValidateBacklogSchema, runValidateBacklog),
});

export const requestPlanApprovalTask = task({
  id: 'request-plan-approval',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('request-plan-approval', RequestPlanApprovalSchema, runRequestPlanApproval),
});

export const activateApprovedBacklogTask = task({
  id: 'activate-approved-backlog',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner(
    'activate-approved-backlog',
    ActivateApprovedBacklogSchema,
    runActivateBacklog,
  ),
});

export const startNextFeatureTask = task({
  id: 'start-next-feature',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('start-next-feature', StartNextFeatureSchema, runStartNextFeature),
});

export const runCoderTask = task({
  id: 'run-coder',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('run-coder', RunCoderSchema, runRunCoder),
});

export const runReviewTask = task({
  id: 'run-review',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('run-review', RunReviewSchema, runRunReview),
});

export const runMergeGateTask = task({
  id: 'run-merge-gate',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('run-merge-gate', RunMergeGateSchema, runRunMergeGate),
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

export const importBacklogTask = task({
  id: 'import-backlog',
  queue: { concurrencyLimit: 1 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('import-backlog', ImportBacklogSchema, runImportBacklog),
});

export const runDesignDocTask = task({
  id: 'run-design-doc',
  queue: { concurrencyLimit: 5 },
  retry: RETRY_CONFIG,
  run: makeTaskRunner('run-design-doc', RunDesignDocSchema, runRunDesignDoc),
});

export { ALL_TASK_IDS } from './task-ids.js';
export type { TaskId } from './task-ids.js';
