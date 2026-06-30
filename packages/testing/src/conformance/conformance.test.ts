import { describe, it, expect, beforeEach } from 'vitest';
import { AdapterRegistry, AgentRunRecorder, generateId } from '@minicoder/core';
import type { ConformanceSuiteResult } from './types.js';
import { runConformanceSuite } from './runner.js';
import { createTestDb } from '../db.js';
import type { SqliteDbClient } from '@minicoder/persistence-sqlite';

let db: SqliteDbClient;
let registry: AdapterRegistry;
let recorder: AgentRunRecorder;
let results: ConformanceSuiteResult[];

describe('Phase 5 smoke adapter conformance suite', () => {
  beforeEach(async () => {
    db = createTestDb();
    registry = new AdapterRegistry(db);
    recorder = new AgentRunRecorder(db, registry);
    results = await runConformanceSuite({ db, registry, recorder });
  });

  it('runs conformance for all 6 adapters (one per role, including HumanTestAdapter)', () => {
    expect(results).toHaveLength(6);
    const names = results.map((r) => r.adapterName).sort();
    expect(names).toEqual(
      [
        'HumanTestAdapter',
        'MockArbiterAdapter',
        'MockCoderAdapter',
        'MockDocumentationAdapter',
        'MockPlannerAdapter',
        'MockReviewerAdapter',
      ].sort(),
    );
  });

  it('all adapters pass every non-skipped conformance scenario', () => {
    const failures: string[] = [];
    for (const suite of results) {
      for (const scenario of suite.scenarios) {
        if (!scenario.passed && !scenario.skipped) {
          failures.push(
            `${suite.adapterName}/${scenario.scenarioName}: ${scenario.details}${scenario.error ? ` (${scenario.error})` : ''}`,
          );
        }
      }
    }
    expect(failures, `Conformance failures:\n${failures.join('\n')}`).toHaveLength(0);
  });

  it('skipped scenarios are not counted as passed', () => {
    for (const suite of results) {
      for (const scenario of suite.scenarios) {
        if (scenario.skipped) {
          expect(scenario.passed).toBe(false);
        }
      }
    }
  });

  it('MockCoderAdapter has 0 skipped scenarios; all other adapters skip invalid_output_handling', () => {
    for (const suite of results) {
      if (suite.adapterName === 'MockCoderAdapter') {
        expect(suite.skippedCount).toBe(0);
      } else {
        expect(suite.skippedCount).toBe(1);
        const skipped = suite.scenarios.find((s) => s.skipped);
        expect(skipped?.scenarioName).toBe('invalid_output_handling');
      }
    }
  });

  it('writes adapter_conformance_results rows to the database for each adapter', async () => {
    const rows = await db.query<{
      id: string;
      role: string;
      passed: number;
      total_tests: number;
      skipped_tests: number;
    }>(
      `SELECT id, role, passed, total_tests, skipped_tests FROM adapter_conformance_results WHERE test_suite = 'phase5-smoke-conformance'`,
      [],
    );
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.total_tests).toBe(9);
    }
  });

  it('all written conformance results have passed=1', async () => {
    const failedRows = await db.query<{ role: string; failed_tests: number }>(
      `SELECT role, failed_tests FROM adapter_conformance_results WHERE test_suite = 'phase5-smoke-conformance' AND passed = 0`,
      [],
    );
    expect(
      failedRows,
      `Adapters with failed conformance: ${failedRows.map((r) => r.role).join(', ')}`,
    ).toHaveLength(0);
  });

  it('adapter_conformance_results skipped_tests=0 for MockCoderAdapter and =1 for others', async () => {
    const rows = await db.query<{ role: string; skipped_tests: number }>(
      `SELECT role, skipped_tests FROM adapter_conformance_results WHERE test_suite = 'phase5-smoke-conformance'`,
      [],
    );
    for (const row of rows) {
      if (row.role === 'CoderAgentAdapter') {
        expect(row.skipped_tests).toBe(0);
      } else {
        expect(row.skipped_tests).toBe(1);
      }
    }
  });

  it('agent_runs rows are created and reach succeeded state for successful scenarios', async () => {
    const succeededRuns = await db.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE state = 'succeeded'`,
      [],
    );
    expect(succeededRuns.length).toBeGreaterThan(0);
  });

  it('agent_runs rows store immutable adapter provenance snapshot', async () => {
    const rows = await db.query<{
      adapter_name: string;
      adapter_implementation: string;
      adapter_version: number;
      capabilities_used: string;
    }>(
      `SELECT adapter_name, adapter_implementation, adapter_version, capabilities_used
       FROM agent_runs WHERE adapter_name IS NOT NULL LIMIT 1`,
      [],
    );
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    expect(typeof row.adapter_name).toBe('string');
    expect(typeof row.adapter_implementation).toBe('string');
    expect(row.adapter_version).toBeGreaterThanOrEqual(1);
    const caps = JSON.parse(row.capabilities_used) as unknown[];
    expect(Array.isArray(caps)).toBe(true);
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

  it('a failed conformance result row writes passed=0 to the database', async () => {
    const now = new Date().toISOString();
    const fakeAdapterId = results[0]!.adapterId;
    const rowId = generateId();
    await db.execute(
      `INSERT INTO adapter_conformance_results
         (id, adapter_id, role, test_suite, passed, total_tests, failed_tests, skipped_tests, details, run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rowId,
        fakeAdapterId,
        'PlannerAgentAdapter',
        'phase5-smoke-conformance-failed',
        0,
        9,
        3,
        0,
        '{}',
        now,
        now,
      ],
    );
    const failedRows = await db.query<{ id: string; passed: number }>(
      `SELECT id, passed FROM adapter_conformance_results WHERE test_suite = 'phase5-smoke-conformance-failed' AND passed = 0`,
      [],
    );
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]!.passed).toBe(0);
  });
});
