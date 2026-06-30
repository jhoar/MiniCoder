import { describe, it, expect, beforeEach } from 'vitest';
import { AdapterRegistry, AgentRunRecorder } from '@minicoder/core';
import type { ConformanceSuiteResult } from './types.js';
import { runConformanceSuite } from './runner.js';
import { createTestDb } from '../db.js';
import type { SqliteDbClient } from '@minicoder/persistence-sqlite';

let db: SqliteDbClient;
let registry: AdapterRegistry;
let recorder: AgentRunRecorder;
let results: ConformanceSuiteResult[];

describe('Phase 5 adapter conformance suite', () => {
  beforeEach(async () => {
    db = createTestDb();
    registry = new AdapterRegistry(db);
    recorder = new AgentRunRecorder(db);
    results = await runConformanceSuite({ db, registry, recorder });
  });

  it('runs conformance for all 6 adapters (one per role, including HumanTestAdapter)', () => {
    expect(results).toHaveLength(6);
    const names = results.map((r) => r.adapterName).sort();
    expect(names).toEqual([
      'HumanTestAdapter',
      'MockArbiterAdapter',
      'MockCoderAdapter',
      'MockDocumentationAdapter',
      'MockPlannerAdapter',
      'MockReviewerAdapter',
    ].sort());
  });

  it('all adapters pass every conformance scenario', () => {
    const failures: string[] = [];
    for (const suite of results) {
      for (const scenario of suite.scenarios) {
        if (!scenario.passed) {
          failures.push(`${suite.adapterName}/${scenario.scenarioName}: ${scenario.details}${scenario.error ? ` (${scenario.error})` : ''}`);
        }
      }
    }
    expect(failures, `Conformance failures:\n${failures.join('\n')}`).toHaveLength(0);
  });

  it('writes adapter_conformance_results rows to the database for each adapter', async () => {
    const rows = await db.query<{ id: string; role: string; passed: number; total_tests: number }>(
      `SELECT id, role, passed, total_tests FROM adapter_conformance_results WHERE test_suite = 'phase5-conformance'`,
      [],
    );
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.total_tests).toBeGreaterThan(0);
    }
  });

  it('all written conformance results have passed=1', async () => {
    const failedRows = await db.query<{ role: string; failed_tests: number }>(
      `SELECT role, failed_tests FROM adapter_conformance_results WHERE test_suite = 'phase5-conformance' AND passed = 0`,
      [],
    );
    expect(
      failedRows,
      `Adapters with failed conformance: ${failedRows.map((r) => r.role).join(', ')}`,
    ).toHaveLength(0);
  });

  it('agent_runs rows are created and reach succeeded state for successful scenarios', async () => {
    const succeededRuns = await db.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE state = 'succeeded'`,
      [],
    );
    expect(succeededRuns.length).toBeGreaterThan(0);
  });

  it('agent_errors rows are created for the CoderAgentAdapter failure scenario', async () => {
    const errorRows = await db.query<{ error_type: string; message: string }>(
      `SELECT ae.error_type, ae.message FROM agent_errors ae
       JOIN agent_runs ar ON ae.agent_run_id = ar.id
       WHERE ar.role = 'CoderAgentAdapter'`,
      [],
    );
    expect(errorRows.length).toBeGreaterThan(0);
    const types = errorRows.map((r) => r.error_type);
    expect(types).toContain('provider_unavailable');
  });
});
