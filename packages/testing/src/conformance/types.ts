import type { DbClient } from '@minicoder/core';
import type { AdapterRegistry, AgentRunRecorder } from '@minicoder/core';

export interface ConformanceScenarioResult {
  readonly scenarioName: string;
  readonly passed: boolean;
  readonly details: string;
  readonly error?: string;
}

export interface ConformanceSuiteResult {
  readonly adapterId: string;
  readonly role: string;
  readonly adapterName: string;
  readonly scenarios: readonly ConformanceScenarioResult[];
  readonly passedCount: number;
  readonly failedCount: number;
  readonly totalCount: number;
  /** Row ID written to adapter_conformance_results for this suite run. */
  readonly conformanceResultId: string;
}

export interface ConformanceRunOptions {
  readonly db: DbClient;
  readonly registry: AdapterRegistry;
  readonly recorder: AgentRunRecorder;
}
