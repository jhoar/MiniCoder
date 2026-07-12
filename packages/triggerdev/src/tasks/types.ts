import { z } from 'zod';

export const BasePayload = z.object({
  projectId: z.string(),
  correlationId: z.string(),
  idempotencyKey: z.string(),
});

/** Identifies the human actor on behalf of whom a human-actor command is invoked (Phase 13 will replace this with real API-session identity). */
export const ActorPayload = z.object({
  actorId: z.string(),
  actorRole: z.enum(['viewer', 'operator', 'approver', 'admin']),
});

export const IngestSpecificationPayload = BasePayload.merge(ActorPayload).extend({
  content: z.string(),
  contentType: z.string().default('text/plain'),
});

export const PlanningReadinessPayload = BasePayload.extend({
  specificationInputId: z.string().nullable().optional(),
  specificationContent: z.string(),
  plannerAdapterName: z.string().default('MockPlannerAdapter'),
});

export const StartClarificationPayload = BasePayload.merge(ActorPayload).extend({
  clarificationSessionId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});

export const RecordClarificationAnswerPayload = BasePayload.merge(ActorPayload).extend({
  clarificationQuestionId: z.string(),
  clarificationSessionId: z.string(),
  answer: z.string(),
  expectedQuestionVersion: z.number().int().nonnegative(),
});

export const CompleteClarificationPayload = BasePayload.merge(ActorPayload).extend({
  clarificationSessionId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  /**
   * Whether the specification (now augmented with the round's answers) is sufficient — determined
   * by re-running PlannerAgentAdapter upstream of this task, the same way the caller ran it for
   * AssessPlanningReadinessCommand. Drives which of CompleteClarificationCommand /
   * RequestAnotherClarificationRoundCommand / BlockClarificationCommand this task dispatches to.
   */
  readinessResult: z.enum(['sufficient', 'sufficient_with_assumptions', 'insufficient']),
});

export const GenerateImplementationPlanPayload = BasePayload.extend({
  assessmentId: z.string(),
  title: z.string(),
  summary: z.string().nullable().optional(),
  sections: z.array(z.object({ title: z.string(), content: z.string() })).default([]),
});

const FeatureBacklogEntry = z.object({
  frId: z.string(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(['feature', 'discovery']).default('feature'),
  priority: z.number().int().default(0),
  dependsOnFrIds: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  testExpectations: z
    .array(
      z.object({
        description: z.string(),
        testType: z.enum(['unit', 'integration', 'system']).nullable(),
      }),
    )
    .default([]),
});

export const GenerateFeatureBacklogPayload = BasePayload.extend({
  planId: z.string(),
  // Must match GenerateFeatureBacklogHandler's own schema (.min(1)) — an empty/missing array is a
  // caller error, not a valid "nothing to generate" no-op.
  features: z.array(FeatureBacklogEntry).min(1),
});

export const ValidateBacklogPayload = BasePayload.extend({
  planId: z.string(),
});

export const RequestPlanApprovalPayload = BasePayload.merge(ActorPayload).extend({
  planId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});

export const ActivateApprovedBacklogPayload = BasePayload.merge(ActorPayload).extend({
  planId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});

export const StartNextFeaturePayload = BasePayload.extend({
  featureRunId: z.string().optional(),
});

export const GithubReconciliationPayload = BasePayload.extend({
  featureRunId: z.string().optional(),
});

export const RunCoderPayload = BasePayload.extend({
  featureRunId: z.string(),
  // MEDIUM-3 code-review fix: no default. A default of 'MockCoderAdapter' let a production
  // trigger that omitted this field silently resolve a test adapter instead of the real
  // CodexCoderAdapter the default resolver constructs — callers must name the adapter explicitly.
  coderAdapterName: z.string(),
});

export const RunMergeGatePayload = BasePayload.extend({
  featureRunId: z.string(),
});

export const RunReviewPayload = BasePayload.extend({
  featureRunId: z.string(),
  // No default, per Phase 9's MEDIUM-3 precedent ("no silent test-adapter default in production
  // payloads") — every production/test call site must name the adapter explicitly.
  reviewerAdapterName: z.string(),
  // Phase 11: only consulted when run-review.ts detects a repeated unresolved finding (a
  // coder/reviewer disagreement) and needs to invoke ArbiterAgentAdapter. Optional because most
  // review cycles never hit a disagreement; omitting it is only an error at the point a
  // disagreement is actually detected (see run-review.ts's actionable-error message).
  arbiterAdapterName: z.string().optional(),
});

export const ExportPlanPayload = BasePayload.merge(ActorPayload).extend({
  planId: z.string(),
});

export const ExportBacklogPayload = BasePayload.merge(ActorPayload).extend({
  planId: z.string(),
});

const ImportBacklogEntry = z.object({
  frId: z.string(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(['feature', 'discovery']).default('feature'),
  priority: z.number().int().default(0),
  dependsOnFrIds: z.array(z.string()).default([]),
});

export const ImportBacklogPayload = BasePayload.merge(ActorPayload).extend({
  planId: z.string(),
  features: z.array(ImportBacklogEntry),
  dryRun: z.boolean().default(false),
});

export const RunDesignDocPayload = BasePayload.extend({
  // No default, per Phase 9's MEDIUM-3 precedent ("no silent test-adapter default in production
  // payloads") — every production/test call site must name the adapter explicitly.
  documentationAdapterName: z.string(),
});

export type IngestSpecificationPayload = z.infer<typeof IngestSpecificationPayload>;
export type PlanningReadinessPayload = z.infer<typeof PlanningReadinessPayload>;
export type StartClarificationPayload = z.infer<typeof StartClarificationPayload>;
export type RecordClarificationAnswerPayload = z.infer<typeof RecordClarificationAnswerPayload>;
export type CompleteClarificationPayload = z.infer<typeof CompleteClarificationPayload>;
export type GenerateImplementationPlanPayload = z.infer<typeof GenerateImplementationPlanPayload>;
export type GenerateFeatureBacklogPayload = z.infer<typeof GenerateFeatureBacklogPayload>;
export type ValidateBacklogPayload = z.infer<typeof ValidateBacklogPayload>;
export type RequestPlanApprovalPayload = z.infer<typeof RequestPlanApprovalPayload>;
export type ActivateApprovedBacklogPayload = z.infer<typeof ActivateApprovedBacklogPayload>;
export type StartNextFeaturePayload = z.infer<typeof StartNextFeaturePayload>;
export type GithubReconciliationPayload = z.infer<typeof GithubReconciliationPayload>;
export type RunCoderPayload = z.infer<typeof RunCoderPayload>;
export type RunReviewPayload = z.infer<typeof RunReviewPayload>;
export type RunMergeGatePayload = z.infer<typeof RunMergeGatePayload>;
export type ExportPlanPayload = z.infer<typeof ExportPlanPayload>;
export type ExportBacklogPayload = z.infer<typeof ExportBacklogPayload>;
export type ImportBacklogPayload = z.infer<typeof ImportBacklogPayload>;
export type RunDesignDocPayload = z.infer<typeof RunDesignDocPayload>;
