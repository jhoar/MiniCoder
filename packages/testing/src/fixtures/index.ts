import type { FixtureName, Fixture } from './types.js';
import { planningBasicFixture } from './planning-basic.js';
import { planningReviewMergeFixture } from './planning-review-merge.js';
import { clarificationRequiredFixture } from './clarification-required.js';
import { backlogActivationFixture } from './backlog-activation.js';
import { reviewLoopFixture } from './review-loop.js';
import { mergeGateFixture } from './merge-gate.js';
import { triggerRetryFixture } from './trigger-retry.js';
import { githubRaceFixture } from './github-race.js';
import { finalDesignDocumentFixture } from './final-design-document.js';

export const FIXTURE_REGISTRY: Map<FixtureName, Fixture> = new Map([
  ['planning-basic', planningBasicFixture],
  ['planning-review-merge', planningReviewMergeFixture],
  ['clarification-required', clarificationRequiredFixture],
  ['backlog-activation', backlogActivationFixture],
  ['review-loop', reviewLoopFixture],
  ['merge-gate', mergeGateFixture],
  ['trigger-retry', triggerRetryFixture],
  ['github-race', githubRaceFixture],
  ['final-design-document', finalDesignDocumentFixture],
]);

export function getFixture(name: FixtureName): Fixture {
  const fixture = FIXTURE_REGISTRY.get(name);
  if (!fixture) {
    throw new Error(`Unknown fixture: ${name}`);
  }
  return fixture;
}

export type { FixtureName, Fixture } from './types.js';
