import type { DbClient } from '@minicoder/core';
import type { MockTriggerRunner } from '@minicoder/triggerdev';
import type { MockPlannerAdapter } from '../adapters/mock-planner.js';
import type { MockCoderAdapter } from '../adapters/mock-coder.js';
import type { MockReviewerAdapter } from '../adapters/mock-reviewer.js';
import type { MockArbiterAdapter } from '../adapters/mock-arbiter.js';
import type { MockDocumentationAdapter } from '../adapters/mock-documentation.js';
import type { HumanTestAdapter } from '../adapters/human-test-adapter.js';
import type { MockGitHubProvider } from '../services/mock-github-provider.js';
import type { MockCostProvider } from '../services/mock-cost-provider.js';
import type { MockArtifactStorage } from '../services/mock-artifact-storage.js';

export interface ScenarioContext {
  db: DbClient;
  projectId: string;
  runner: MockTriggerRunner;
  planner: MockPlannerAdapter;
  coder: MockCoderAdapter;
  reviewer: MockReviewerAdapter;
  arbiter: MockArbiterAdapter;
  documentation: MockDocumentationAdapter;
  human: HumanTestAdapter;
  github: MockGitHubProvider;
  cost: MockCostProvider;
  storage: MockArtifactStorage;
}

export interface ScenarioResult {
  passed: boolean;
  assertions: AssertionResult[];
  durationMs: number;
  error?: string;
}

export interface AssertionResult {
  label: string;
  passed: boolean;
  actual?: unknown;
  expected?: unknown;
  error?: string;
}

export interface Scenario {
  name: string;
  description: string;
  fixtureName: string;
  run(ctx: ScenarioContext): Promise<void>;
}
