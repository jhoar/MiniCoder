import { z } from 'zod';

// Schema version string included in every outbox/inbox event row.
// Bump this when the payload shape changes; consumers validate against the
// stored version so old rows remain processable.

export const SCHEMA_VERSION = '1.0.0';

// ── Feature execution events ──────────────────────────────────────────────

export const FeatureSelectedPayloadSchema = z.object({
  featureRunId: z.string().uuid(),
  projectId: z.string().uuid(),
  fromState: z.literal('approved_pending_execution'),
  toState: z.literal('selected'),
});
export type FeatureSelectedPayload = z.infer<typeof FeatureSelectedPayloadSchema>;

export const FeatureCodingStartedPayloadSchema = z.object({
  featureRunId: z.string().uuid(),
  projectId: z.string().uuid(),
});
export type FeatureCodingStartedPayload = z.infer<typeof FeatureCodingStartedPayloadSchema>;

export const FeatureCodePushedPayloadSchema = z.object({
  featureRunId: z.string().uuid(),
  projectId: z.string().uuid(),
  commitSha: z.string(),
});
export type FeatureCodePushedPayload = z.infer<typeof FeatureCodePushedPayloadSchema>;

export const FeatureCiRunningPayloadSchema = z.object({
  featureRunId: z.string().uuid(),
  projectId: z.string().uuid(),
  checkRunId: z.string(),
});
export type FeatureCiRunningPayload = z.infer<typeof FeatureCiRunningPayloadSchema>;

export const FeatureCiResultPayloadSchema = z.object({
  featureRunId: z.string().uuid(),
  projectId: z.string().uuid(),
  checkRunId: z.string(),
  conclusion: z.enum(['success', 'failure', 'cancelled', 'timed_out']),
});
export type FeatureCiResultPayload = z.infer<typeof FeatureCiResultPayloadSchema>;

export const FeatureMergedPayloadSchema = z.object({
  featureRunId: z.string().uuid(),
  projectId: z.string().uuid(),
  mergeSha: z.string(),
});
export type FeatureMergedPayload = z.infer<typeof FeatureMergedPayloadSchema>;

export const FeatureHumanRequiredPayloadSchema = z.object({
  featureRunId: z.string().uuid(),
  projectId: z.string().uuid(),
  reason: z.string(),
});
export type FeatureHumanRequiredPayload = z.infer<typeof FeatureHumanRequiredPayloadSchema>;

// ── Plan events ───────────────────────────────────────────────────────────

export const PlanApprovedPayloadSchema = z.object({
  planId: z.string().uuid(),
  projectId: z.string().uuid(),
});
export type PlanApprovedPayload = z.infer<typeof PlanApprovedPayloadSchema>;

export const PlanActivatedPayloadSchema = z.object({
  planId: z.string().uuid(),
  projectId: z.string().uuid(),
  featureRequestCount: z.number().int().nonnegative(),
});
export type PlanActivatedPayload = z.infer<typeof PlanActivatedPayloadSchema>;

// ── Automation control events ─────────────────────────────────────────────

export const AutomationPausedPayloadSchema = z.object({
  projectId: z.string().uuid(),
  reason: z.enum(['operator', 'budget_exceeded', 'budget_approval_waiting']),
});
export type AutomationPausedPayload = z.infer<typeof AutomationPausedPayloadSchema>;

export const AutomationResumedPayloadSchema = z.object({
  projectId: z.string().uuid(),
});
export type AutomationResumedPayload = z.infer<typeof AutomationResumedPayloadSchema>;

// ── Registry: eventType → schema ─────────────────────────────────────────

export const EVENT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'feature.selected': FeatureSelectedPayloadSchema,
  'feature.coding_started': FeatureCodingStartedPayloadSchema,
  'feature.code_pushed': FeatureCodePushedPayloadSchema,
  'feature.ci_running': FeatureCiRunningPayloadSchema,
  'feature.ci_passed': FeatureCiResultPayloadSchema,
  'feature.ci_failed': FeatureCiResultPayloadSchema,
  'feature.merged': FeatureMergedPayloadSchema,
  'feature.human_required': FeatureHumanRequiredPayloadSchema,
  'plan.approved': PlanApprovedPayloadSchema,
  'plan.activated': PlanActivatedPayloadSchema,
  'automation.paused_by_operator': AutomationPausedPayloadSchema,
  'automation.budget_exceeded': AutomationPausedPayloadSchema,
  'automation.resumed': AutomationResumedPayloadSchema,
};

export function validateEventPayload(eventType: string, payload: unknown): void {
  const schema = EVENT_SCHEMAS[eventType];
  if (schema) {
    schema.parse(payload);
  }
}
