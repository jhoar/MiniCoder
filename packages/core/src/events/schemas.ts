import { z } from 'zod';

// Schema version string included in every outbox/inbox event row.
// Bump this when the payload shape changes; consumers validate against the
// stored version so old rows remain processable.

export const SCHEMA_VERSION = '1.0.0';

// ── Feature execution events ──────────────────────────────────────────────

// ID fields across every schema in this file use `.min(1)`, never `.uuid()` — every ID in this
// system (feature_runs.id, projects.id, implementation_plans.id, etc.) is a
// `commands/helpers.ts`'s `generateId()` string (`${Date.now()}-${random}`), never a UUID.
// `.uuid()` here would reject every real payload the command layer ever emits, marking the event
// `failed` at the `InboxProcessor` validation boundary without ever invoking the handler (Phase 9
// review, round 2: a first pass only fixed `FeatureCodePushedPayloadSchema`, the schema Phase 9
// directly touched, leaving the identical mismatch live on every other schema below — the same
// class of bug, just not yet finished. Fixed everywhere in this file now that the split-contract
// risk was flagged.).
export const FeatureSelectedPayloadSchema = z.object({
  featureRunId: z.string().min(1),
  projectId: z.string().min(1),
  fromState: z.literal('approved_pending_execution'),
  toState: z.literal('selected'),
});
export type FeatureSelectedPayload = z.infer<typeof FeatureSelectedPayloadSchema>;

export const FeatureCodingStartedPayloadSchema = z.object({
  featureRunId: z.string().min(1),
  projectId: z.string().min(1),
});
export type FeatureCodingStartedPayload = z.infer<typeof FeatureCodingStartedPayloadSchema>;

export const FeatureCodePushedPayloadSchema = z.object({
  featureRunId: z.string().min(1),
  projectId: z.string().min(1),
  commitSha: z.string(),
  branchName: z.string(),
  filesChanged: z.number().int().nonnegative(),
});
export type FeatureCodePushedPayload = z.infer<typeof FeatureCodePushedPayloadSchema>;

export const FeatureCiRunningPayloadSchema = z.object({
  featureRunId: z.string().min(1),
  projectId: z.string().min(1),
  checkRunId: z.string(),
});
export type FeatureCiRunningPayload = z.infer<typeof FeatureCiRunningPayloadSchema>;

export const FeatureCiResultPayloadSchema = z.object({
  featureRunId: z.string().min(1),
  projectId: z.string().min(1),
  checkRunId: z.string(),
  conclusion: z.enum(['success', 'failure', 'cancelled', 'timed_out']),
});
export type FeatureCiResultPayload = z.infer<typeof FeatureCiResultPayloadSchema>;

export const FeatureMergedPayloadSchema = z.object({
  featureRunId: z.string().min(1),
  projectId: z.string().min(1),
  mergeSha: z.string(),
});
export type FeatureMergedPayload = z.infer<typeof FeatureMergedPayloadSchema>;

export const FeatureHumanRequiredPayloadSchema = z.object({
  featureRunId: z.string().min(1),
  projectId: z.string().min(1),
  reason: z.string(),
});
export type FeatureHumanRequiredPayload = z.infer<typeof FeatureHumanRequiredPayloadSchema>;

// ── Phase 7: GitHub-facing feature execution events ──────────────────────

export const FeaturePrOpenedPayloadSchema = z.object({
  featureRunId: z.string().min(1),
  projectId: z.string().min(1),
  prNumber: z.number().int().positive(),
  branchName: z.string(),
  baseBranch: z.string(),
});
export type FeaturePrOpenedPayload = z.infer<typeof FeaturePrOpenedPayloadSchema>;

export const FeatureChangesRequestedPayloadSchema = z.object({
  featureRunId: z.string().min(1),
  projectId: z.string().min(1),
  reviewId: z.string(),
  reviewer: z.string().nullable(),
});
export type FeatureChangesRequestedPayload = z.infer<typeof FeatureChangesRequestedPayloadSchema>;

// ── Plan events ───────────────────────────────────────────────────────────

export const PlanApprovedPayloadSchema = z.object({
  planId: z.string().min(1),
  projectId: z.string().min(1),
});
export type PlanApprovedPayload = z.infer<typeof PlanApprovedPayloadSchema>;

export const PlanActivatedPayloadSchema = z.object({
  planId: z.string().min(1),
  projectId: z.string().min(1),
  featureRequestCount: z.number().int().nonnegative(),
});
export type PlanActivatedPayload = z.infer<typeof PlanActivatedPayloadSchema>;

// ── Automation control events ─────────────────────────────────────────────

export const AutomationPausedPayloadSchema = z.object({
  projectId: z.string().min(1),
  reason: z.enum(['operator', 'budget_exceeded', 'budget_approval_waiting']),
});
export type AutomationPausedPayload = z.infer<typeof AutomationPausedPayloadSchema>;

export const AutomationResumedPayloadSchema = z.object({
  projectId: z.string().min(1),
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
  'feature.pr_opened': FeaturePrOpenedPayloadSchema,
  'feature.changes_requested': FeatureChangesRequestedPayloadSchema,
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
