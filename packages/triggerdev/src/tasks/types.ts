import { z } from 'zod';

export const BasePayload = z.object({
  projectId: z.string(),
  correlationId: z.string(),
  idempotencyKey: z.string(),
});

export const PlanningReadinessPayload = BasePayload;
export const StartClarificationPayload = BasePayload;
export const GenerateImplementationPlanPayload = BasePayload;
export const GenerateFeatureBacklogPayload = BasePayload;

export const ActivateApprovedBacklogPayload = BasePayload.extend({
  planId: z.string(),
});

export const StartNextFeaturePayload = BasePayload.extend({
  featureRunId: z.string().optional(),
});

export const GithubReconciliationPayload = BasePayload.extend({
  featureRunId: z.string().optional(),
});

export const ExportPlanPayload = BasePayload.extend({
  planId: z.string(),
  outputPath: z.string().optional(),
});

export const ExportBacklogPayload = BasePayload.extend({
  outputPath: z.string().optional(),
});

export type PlanningReadinessPayload = z.infer<typeof PlanningReadinessPayload>;
export type StartClarificationPayload = z.infer<typeof StartClarificationPayload>;
export type GenerateImplementationPlanPayload = z.infer<typeof GenerateImplementationPlanPayload>;
export type GenerateFeatureBacklogPayload = z.infer<typeof GenerateFeatureBacklogPayload>;
export type ActivateApprovedBacklogPayload = z.infer<typeof ActivateApprovedBacklogPayload>;
export type StartNextFeaturePayload = z.infer<typeof StartNextFeaturePayload>;
export type GithubReconciliationPayload = z.infer<typeof GithubReconciliationPayload>;
export type ExportPlanPayload = z.infer<typeof ExportPlanPayload>;
export type ExportBacklogPayload = z.infer<typeof ExportBacklogPayload>;
