import { describe, it, expect } from 'vitest';
import type { DbClient, TxClient } from '../persistence/types.js';
import { evaluateBudget, type BudgetPolicyRow } from './budget-evaluator.js';

interface CostRecordRow {
  project_id: string;
  feature_request_id: string | null;
  scope: string;
  amount: number;
  recorded_at: string;
}

/** Minimal purpose-built fake covering only the two SELECT shapes evaluateBudget issues. */
class FakeCostDb implements DbClient {
  constructor(
    private readonly policies: BudgetPolicyRow[],
    private readonly costRecords: CostRecordRow[],
  ) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id, project_id, scope, feature_request_id')) {
      const [projectId, scope, featureRequestId] = params as [string, string, string | null];
      // Mirrors the real query's `ORDER BY updated_at DESC, id DESC` so tests exercising the
      // deterministic-selection tiebreaker (MEDIUM-3) observe the same ordering a real DB would.
      return this.policies
        .filter(
          (p) =>
            p.project_id === projectId &&
            p.scope === scope &&
            (p.feature_request_id === featureRequestId ||
              (p.feature_request_id === null && featureRequestId === null)),
        )
        .sort((a, b) => {
          const updatedDiff = String(b.updated_at).localeCompare(String(a.updated_at));
          if (updatedDiff !== 0) return updatedDiff;
          return String(b.id).localeCompare(String(a.id));
        }) as unknown as T[];
    }
    if (s.startsWith('SELECT COALESCE(SUM(amount), 0) as total')) {
      const [projectId, scope] = params as [string, string, ...unknown[]];
      const rest = params.slice(2);
      let matches = this.costRecords.filter((r) => r.project_id === projectId && r.scope === scope);
      let idx = 0;
      if (s.includes('AND feature_request_id = ?')) {
        const fr = rest[idx++] as string;
        matches = matches.filter((r) => r.feature_request_id === fr);
      }
      if (s.includes('AND recorded_at >= ?')) {
        const cutoff = rest[idx++] as string;
        matches = matches.filter((r) => r.recorded_at >= cutoff);
      }
      const total = matches.reduce((sum, r) => sum + r.amount, 0);
      return [{ total }] as unknown as T[];
    }
    throw new Error(`FakeCostDb: unsupported SELECT: ${s}`);
  }

  async execute(): Promise<void> {
    throw new Error('FakeCostDb: execute not supported');
  }

  async executeAffected(): Promise<number> {
    throw new Error('FakeCostDb: executeAffected not supported');
  }

  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}

function policy(overrides: Partial<BudgetPolicyRow> = {}): BudgetPolicyRow {
  return {
    id: 'policy-1',
    project_id: 'proj-1',
    scope: 'project',
    feature_request_id: null,
    currency: 'USD',
    soft_limit: 50,
    hard_limit: 100,
    window_days: null,
    is_active: 1,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function costRecord(overrides: Partial<CostRecordRow> = {}): CostRecordRow {
  return {
    project_id: 'proj-1',
    feature_request_id: null,
    scope: 'project',
    amount: 10,
    recorded_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('evaluateBudget', () => {
  it('returns null when no active policy exists for the scope', async () => {
    const db = new FakeCostDb([], []);
    const result = await evaluateBudget(db, { projectId: 'proj-1', scope: 'project' });
    expect(result).toBeNull();
  });

  it('ignores inactive policies', async () => {
    const db = new FakeCostDb([policy({ is_active: 0 })], [costRecord({ amount: 1000 })]);
    const result = await evaluateBudget(db, { projectId: 'proj-1', scope: 'project' });
    expect(result).toBeNull();
  });

  it('reports ok when spend is under the soft limit', async () => {
    const db = new FakeCostDb([policy()], [costRecord({ amount: 10 }), costRecord({ amount: 10 })]);
    const result = await evaluateBudget(db, { projectId: 'proj-1', scope: 'project' });
    expect(result?.status).toBe('ok');
    expect(result?.totalSpend).toBe(20);
  });

  it('reports soft_breach when spend meets the soft limit but not the hard limit', async () => {
    const db = new FakeCostDb([policy()], [costRecord({ amount: 60 })]);
    const result = await evaluateBudget(db, { projectId: 'proj-1', scope: 'project' });
    expect(result?.status).toBe('soft_breach');
  });

  it('reports hard_breach and hard wins over soft when both are breached', async () => {
    const db = new FakeCostDb([policy()], [costRecord({ amount: 150 })]);
    const result = await evaluateBudget(db, { projectId: 'proj-1', scope: 'project' });
    expect(result?.status).toBe('hard_breach');
  });

  it('excludes cost_records outside the window_days cutoff', async () => {
    const oldRecord = costRecord({
      amount: 200,
      recorded_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const recentRecord = costRecord({ amount: 10 });
    const db = new FakeCostDb([policy({ window_days: 7 })], [oldRecord, recentRecord]);
    const result = await evaluateBudget(db, { projectId: 'proj-1', scope: 'project' });
    expect(result?.totalSpend).toBe(10);
    expect(result?.status).toBe('ok');
  });

  it('isolates spend by scope so feature/review_cycle records do not leak into project sums', async () => {
    const db = new FakeCostDb(
      [policy({ scope: 'project' })],
      [costRecord({ scope: 'feature', amount: 500 }), costRecord({ scope: 'project', amount: 5 })],
    );
    const result = await evaluateBudget(db, { projectId: 'proj-1', scope: 'project' });
    expect(result?.totalSpend).toBe(5);
    expect(result?.status).toBe('ok');
  });

  it('scopes spend to a specific feature when featureRequestId is provided', async () => {
    const db = new FakeCostDb(
      [policy({ scope: 'feature', feature_request_id: 'fr-1' })],
      [
        costRecord({ scope: 'feature', feature_request_id: 'fr-1', amount: 60 }),
        costRecord({ scope: 'feature', feature_request_id: 'fr-2', amount: 1000 }),
      ],
    );
    const result = await evaluateBudget(db, {
      projectId: 'proj-1',
      scope: 'feature',
      featureRequestId: 'fr-1',
    });
    expect(result?.totalSpend).toBe(60);
    expect(result?.status).toBe('soft_breach');
  });

  it('deterministically picks the most recently updated active policy when more than one matches', async () => {
    const older = policy({
      id: 'policy-old',
      hard_limit: 100,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    const newer = policy({
      id: 'policy-new',
      hard_limit: 500,
      updated_at: '2026-02-01T00:00:00.000Z',
    });

    const dbOldFirst = new FakeCostDb([older, newer], []);
    const dbNewFirst = new FakeCostDb([newer, older], []);

    const resultOldFirst = await evaluateBudget(dbOldFirst, {
      projectId: 'proj-1',
      scope: 'project',
    });
    const resultNewFirst = await evaluateBudget(dbNewFirst, {
      projectId: 'proj-1',
      scope: 'project',
    });

    expect(resultOldFirst?.policy.id).toBe('policy-new');
    expect(resultNewFirst?.policy.id).toBe('policy-new');
  });
});
