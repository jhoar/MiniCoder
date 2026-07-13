/**
 * Trigger.dev replacement: task registration entry point.
 *
 * Replaces `triggerdev-tasks.ts`'s 19 `task({ id, queue, retry, run })` calls (deleted) with a
 * plain, SDK-free data structure — `TASK_REGISTRY` — consumed by `task-worker.ts`'s
 * `TaskQueueDispatcher` and by `minicoder tasks` CLI commands. No `@trigger.dev/sdk` import
 * anywhere in this file or its callers.
 *
 * Each task is still a thin wrapper that handles DB lifecycle tracking (linkRunToDb /
 * updateRunStatus) then delegates to the business-logic runImpl. No business rules live here —
 * this preserves the fitness-test-enforced contract `triggerdev-tasks.ts` documented:
 *   - No state machine imports
 *   - No domain entity mutations outside the command interface
 *   - No secrets in task payloads (RF-12)
 *
 * Concurrency limits and retry envelope are unchanged from the Trigger.dev configuration this
 * replaces: `concurrencyLimit` is 1 for most tasks, 5 for `ingest-specification`/`export-plan`/
 * `export-backlog`/`run-design-doc`. The retry envelope (maxAttempts 3, base 1s, max 30s,
 * exponential) now lives in `task-worker.ts`'s `TaskQueueDispatcher` construction, not here —
 * this file only declares each task's shape, not how the queue retries it.
 */
import { z } from 'zod';
import type { DbClient, PlannerAgentAdapter } from '@minicoder/core';
import { linkRunToDb, updateRunStatus } from './metadata.js';
import { requireNonBlankEnvVar } from './tasks/env.js';
import type { TaskId } from './task-ids.js';

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

/**
 * Constructs the real reference `GenericLLMPlannerAdapter` (issue #32) from env config.
 * Moved verbatim from `triggerdev-tasks.ts` — already SDK-free.
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

export interface TaskDefinition<P = unknown, R = unknown> {
  readonly taskId: TaskId;
  readonly concurrencyLimit: number;
  readonly schema: z.ZodType<P, z.ZodTypeDef, unknown>;
  readonly impl: (payload: P, db: DbClient) => Promise<R>;
}

function def<P extends { projectId?: string }, R>(
  taskId: TaskId,
  concurrencyLimit: number,
  schema: z.ZodType<P, z.ZodTypeDef, unknown>,
  impl: (payload: P, db: DbClient) => Promise<R>,
): [TaskId, TaskDefinition<unknown, unknown>] {
  return [
    taskId,
    { taskId, concurrencyLimit, schema, impl } as unknown as TaskDefinition<unknown, unknown>,
  ];
}

export const TASK_REGISTRY: ReadonlyMap<TaskId, TaskDefinition<unknown, unknown>> = new Map([
  def('ingest-specification', 5, IngestSpecificationSchema, runIngestSpecification),
  def('planning-readiness-assessment', 1, PlanningReadinessSchema, async (payload, db) =>
    runPlanningReadiness(payload, db, await resolveDefaultPlannerAdapter()),
  ),
  def('start-clarification', 1, StartClarificationSchema, runStartClarification),
  def(
    'record-clarification-answer',
    5,
    RecordClarificationAnswerSchema,
    runRecordClarificationAnswer,
  ),
  def('complete-clarification', 1, CompleteClarificationSchema, runCompleteClarification),
  def('generate-implementation-plan', 1, GenerateImplementationPlanSchema, runGeneratePlan),
  def('generate-feature-backlog', 1, GenerateFeatureBacklogSchema, runGenerateBacklog),
  def('validate-backlog', 1, ValidateBacklogSchema, runValidateBacklog),
  def('request-plan-approval', 1, RequestPlanApprovalSchema, runRequestPlanApproval),
  def('activate-approved-backlog', 1, ActivateApprovedBacklogSchema, runActivateBacklog),
  def('start-next-feature', 1, StartNextFeatureSchema, runStartNextFeature),
  def('run-coder', 1, RunCoderSchema, runRunCoder),
  def('run-review', 1, RunReviewSchema, runRunReview),
  def('run-merge-gate', 1, RunMergeGateSchema, runRunMergeGate),
  def('github-reconciliation', 1, GithubReconciliationSchema, runGithubReconciliation),
  def('export-plan', 5, ExportPlanSchema, runExportPlan),
  def('export-backlog', 5, ExportBacklogSchema, runExportBacklog),
  def('import-backlog', 1, ImportBacklogSchema, runImportBacklog),
  def('run-design-doc', 5, RunDesignDocSchema, runRunDesignDoc),
]);

/**
 * Runs one registered task against an already-connected `db` — unlike the old
 * `makeTaskRunner`/`triggerdev-tasks.ts`, this does NOT create or close its own `DbClient`. Each
 * Trigger.dev task previously ran in its own ephemeral container/process, so creating and closing
 * a connection per invocation made sense; `task-worker.ts`'s `TaskQueueDispatcher` is a single
 * long-lived process polling many tasks, so the caller owns one persistent `DbClient` for the
 * whole worker lifetime and passes it in here.
 *
 * Upsert semantics preserved verbatim from `makeTaskRunner`: `linkRunToDb` resets status to
 * 'running' on retry rather than colliding with the UNIQUE constraint on `triggerdev_run_id`.
 */
export async function runRegisteredTask(
  taskId: TaskId,
  rawPayload: unknown,
  runId: string,
  db: DbClient,
  registry: ReadonlyMap<TaskId, TaskDefinition<unknown, unknown>> = TASK_REGISTRY,
): Promise<unknown> {
  const definition = registry.get(taskId);
  if (!definition) {
    throw new Error(`No task registered for id "${taskId}"`);
  }
  const payload = definition.schema.parse(rawPayload) as { projectId?: string };
  await linkRunToDb(db, {
    triggerdevRunId: runId,
    triggerdevTaskId: taskId,
    triggerdevStatus: 'running',
    projectId: payload.projectId,
  });
  try {
    const result = await definition.impl(payload, db);
    await updateRunStatus(db, runId, 'succeeded');
    return result;
  } catch (err) {
    await updateRunStatus(db, runId, 'failed');
    throw err;
  }
}
