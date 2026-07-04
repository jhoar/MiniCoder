import { describe, it, expect } from 'vitest';
import {
  FeatureSelectedPayloadSchema,
  FeatureCodingStartedPayloadSchema,
  FeatureMergedPayloadSchema,
  PlanApprovedPayloadSchema,
  PlanActivatedPayloadSchema,
  AutomationPausedPayloadSchema,
  AutomationResumedPayloadSchema,
} from './schemas.js';

/**
 * HIGH-1 code-review fix (Phase 9 review, round 2): every ID field across every registered event
 * schema must accept `commands/helpers.ts`'s real `generateId()` format
 * (`${Date.now()}-${random}`), never require `.uuid()` — a first review pass only fixed
 * `FeatureCodePushedPayloadSchema` (the schema Phase 9 directly touched), leaving the identical
 * `.uuid()` mismatch live on every other schema in this file. These are the schemas that were
 * still `.uuid()`-gated and have no existing handler-driven regression coverage elsewhere (the
 * Phase 7 GitHub-facing events already have one in
 * packages/testing/src/github-outbox-schemas.test.ts; feature.code_pushed's is in
 * packages/triggerdev/src/tasks/run-coder.test.ts).
 */
function realisticId(label: string): string {
  return `${Date.now()}-${label}-${Math.random().toString(36).slice(2)}`;
}

describe('event schemas accept generateId()-shaped IDs, never require .uuid()', () => {
  it('FeatureSelectedPayloadSchema', () => {
    expect(() =>
      FeatureSelectedPayloadSchema.parse({
        featureRunId: realisticId('run'),
        projectId: realisticId('proj'),
        fromState: 'approved_pending_execution',
        toState: 'selected',
      }),
    ).not.toThrow();
  });

  it('FeatureCodingStartedPayloadSchema', () => {
    expect(() =>
      FeatureCodingStartedPayloadSchema.parse({
        featureRunId: realisticId('run'),
        projectId: realisticId('proj'),
      }),
    ).not.toThrow();
  });

  it('FeatureMergedPayloadSchema', () => {
    expect(() =>
      FeatureMergedPayloadSchema.parse({
        featureRunId: realisticId('run'),
        projectId: realisticId('proj'),
        mergeSha: 'abc123',
      }),
    ).not.toThrow();
  });

  it('PlanApprovedPayloadSchema', () => {
    expect(() =>
      PlanApprovedPayloadSchema.parse({
        planId: realisticId('plan'),
        projectId: realisticId('proj'),
      }),
    ).not.toThrow();
  });

  it('PlanActivatedPayloadSchema', () => {
    expect(() =>
      PlanActivatedPayloadSchema.parse({
        planId: realisticId('plan'),
        projectId: realisticId('proj'),
        featureRequestCount: 3,
      }),
    ).not.toThrow();
  });

  it('AutomationPausedPayloadSchema', () => {
    expect(() =>
      AutomationPausedPayloadSchema.parse({
        projectId: realisticId('proj'),
        reason: 'operator',
      }),
    ).not.toThrow();
  });

  it('AutomationResumedPayloadSchema', () => {
    expect(() =>
      AutomationResumedPayloadSchema.parse({ projectId: realisticId('proj') }),
    ).not.toThrow();
  });
});
