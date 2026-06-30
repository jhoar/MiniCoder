import type { Scenario } from './types.js';
import { planningBasicScenario } from './planning-basic.js';
import { clarificationRequiredScenario } from './clarification-required.js';
import { backlogActivationScenario } from './backlog-activation.js';
import { reviewLoopScenario } from './review-loop.js';
import { mergeGateScenario } from './merge-gate.js';
import { triggerRetryScenario } from './trigger-retry.js';
import { githubRaceScenario } from './github-race.js';
import { finalDesignDocumentScenario } from './final-design-document.js';

export const SCENARIO_REGISTRY: Map<string, Scenario> = new Map([
  ['planning-basic', planningBasicScenario],
  ['clarification-required', clarificationRequiredScenario],
  ['backlog-activation', backlogActivationScenario],
  ['review-loop', reviewLoopScenario],
  ['merge-gate', mergeGateScenario],
  ['trigger-retry', triggerRetryScenario],
  ['github-race', githubRaceScenario],
  ['final-design-document', finalDesignDocumentScenario],
]);

export function getScenario(name: string): Scenario {
  const scenario = SCENARIO_REGISTRY.get(name);
  if (!scenario) {
    throw new Error(
      `Unknown scenario: '${name}'. Available: ${[...SCENARIO_REGISTRY.keys()].join(', ')}`,
    );
  }
  return scenario;
}

export type { Scenario, ScenarioContext, ScenarioResult, AssertionResult } from './types.js';
