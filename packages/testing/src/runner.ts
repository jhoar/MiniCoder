import { createTestDb } from './db.js';
import { MockTriggerRunner } from '@minicoder/triggerdev';
import { MockPlannerAdapter } from './adapters/mock-planner.js';
import { MockCoderAdapter } from './adapters/mock-coder.js';
import { MockReviewerAdapter } from './adapters/mock-reviewer.js';
import { MockArbiterAdapter } from './adapters/mock-arbiter.js';
import { MockDocumentationAdapter } from './adapters/mock-documentation.js';
import { HumanTestAdapter } from './adapters/human-test-adapter.js';
import { MockGitHubProvider } from './services/mock-github-provider.js';
import { MockCostProvider } from './services/mock-cost-provider.js';
import { MockArtifactStorage } from './services/mock-artifact-storage.js';
import { getFixture } from './fixtures/index.js';
import { getScenario, SCENARIO_REGISTRY } from './scenarios/index.js';
import type { ScenarioContext, ScenarioResult } from './scenarios/types.js';

export interface RunScenarioOptions {
  projectId?: string;
}

export async function runScenario(
  name: string,
  options: RunScenarioOptions = {},
): Promise<ScenarioResult> {
  const scenario = getScenario(name);
  const fixture = getFixture(scenario.fixtureName as Parameters<typeof getFixture>[0]);

  const db = createTestDb();
  const projectId = options.projectId ?? `proj-${name}-${Date.now()}`;

  await fixture.setup(db, projectId);

  const ctx: ScenarioContext = {
    db,
    projectId,
    runner: new MockTriggerRunner(db, projectId),
    planner: new MockPlannerAdapter(),
    coder: new MockCoderAdapter(),
    reviewer: new MockReviewerAdapter(),
    arbiter: new MockArbiterAdapter(),
    documentation: new MockDocumentationAdapter(),
    human: new HumanTestAdapter([]),
    github: new MockGitHubProvider(),
    cost: new MockCostProvider(),
    storage: new MockArtifactStorage(),
  };

  const startMs = Date.now();
  const assertions: ScenarioResult['assertions'] = [];

  try {
    await scenario.run(ctx);

    return {
      passed: true,
      assertions,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assertions.push({
      label: 'scenario completed without error',
      passed: false,
      error: message,
    });

    return {
      passed: false,
      assertions,
      durationMs: Date.now() - startMs,
      error: message,
    };
  }
}

export interface RunAllScenariosResult {
  total: number;
  passed: number;
  failed: number;
  results: Array<{ name: string } & ScenarioResult>;
}

export async function runAllScenarios(
  options: RunScenarioOptions = {},
): Promise<RunAllScenariosResult> {
  const results: Array<{ name: string } & ScenarioResult> = [];

  for (const name of SCENARIO_REGISTRY.keys()) {
    const result = await runScenario(name, options);
    results.push({ name, ...result });
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  return {
    total: results.length,
    passed,
    failed,
    results,
  };
}
