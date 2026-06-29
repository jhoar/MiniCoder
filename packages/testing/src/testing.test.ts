import { describe, it, expect } from 'vitest';
import { createTestDb } from './db.js';
import { FIXTURE_REGISTRY } from './fixtures/index.js';
import { runScenario } from './runner.js';

describe('createTestDb', () => {
  it('creates an in-memory SQLite database with all migrations applied', async () => {
    const db = createTestDb();
    const rows = await db.query<{ name: string }>('SELECT name FROM _migrations', []);
    expect(rows.length).toBeGreaterThan(0);
    await db.close();
  });
});

describe('FIXTURE_REGISTRY', () => {
  it('contains all 9 fixtures', () => {
    expect(FIXTURE_REGISTRY.size).toBe(9);
  });

  for (const [name, fixture] of FIXTURE_REGISTRY) {
    it(`fixture '${name}' inserts rows into DB`, async () => {
      const db = createTestDb();
      await fixture.setup(db);
      const rows = await db.query<{ id: string }>(
        `SELECT id FROM projects LIMIT 1`,
        [],
      );
      expect(rows.length).toBeGreaterThan(0);
      await db.close();
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
});
