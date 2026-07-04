import { describe, it, expect } from 'vitest';
import { createTestDb } from './db.js';
import { FIXTURE_REGISTRY } from './fixtures/index.js';
import { runScenario, runAllScenarios } from './runner.js';

describe('createTestDb', () => {
  it('creates an in-memory SQLite database with all migrations applied', async () => {
    const db = createTestDb();
    const rows = await db.query<{ name: string }>('SELECT name FROM _migrations', []);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('FIXTURE_REGISTRY', () => {
  it('contains all 13 fixtures', () => {
    expect(FIXTURE_REGISTRY.size).toBe(13);
  });

  for (const [name, fixture] of FIXTURE_REGISTRY) {
    it(`fixture '${name}' inserts rows into DB`, async () => {
      const db = createTestDb();
      await fixture.setup(db);
      const rows = await db.query<{ id: string }>(`SELECT id FROM projects LIMIT 1`, []);
      expect(rows.length).toBeGreaterThan(0);
    });
  }
});

describe('runScenario', () => {
  it('planning-basic passes', async () => {
    const result = await runScenario('planning-basic');
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('clarification-required passes', async () => {
    const result = await runScenario('clarification-required');
    expect(result.passed).toBe(true);
  });

  it('backlog-activation passes', async () => {
    const result = await runScenario('backlog-activation');
    expect(result.passed).toBe(true);
  });

  it('coder-adapter-run passes', async () => {
    const result = await runScenario('coder-adapter-run');
    expect(result.passed, result.error).toBe(true);
  });
});

describe('runAllScenarios', () => {
  it('all registered scenarios pass', async () => {
    const results = await runAllScenarios();
    for (const r of results.results) {
      expect(r.passed, `Scenario '${r.name}' failed: ${r.error ?? '(no message)'}`).toBe(true);
    }
  });
});
