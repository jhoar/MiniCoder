import { describe, it, expect } from 'vitest';
import type { DbClient, TxClient } from '../persistence/types.js';
import { forecastBudget } from './forecast.js';
import type { BudgetPolicyRow } from './budget-evaluator.js';

interface CostRecordRow {
  project_id: string;
  feature_request_id: string | null;
  scope: string;
  amount: number;
  recorded_at: string;
}

/** Same purpose-built fake shape as budget-evaluator.test.ts's FakeCostDb — forecastBudget()
 * issues the identical two SELECT shapes. */
class FakeCostDb implements DbClient {
  constructor(
    private readonly policies: BudgetPolicyRow[],
    private readonly costRecords: CostRecordRow[],
  ) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id, project_id, scope, feature_request_id')) {
      const [projectId, scope, featureRequestId] = params as [string, string, string | null];
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

describe('forecastBudget', () => {
  it('returns null when no active policy exists for the scope', async () => {
    const db = new FakeCostDb([], []);
    const result = await forecastBudget(db, {
      projectId: 'proj-1',
      scope: 'project',
      estimatedCostUsd: 5,
    });
    expect(result).toBeNull();
  });

  it('reports ok when current spend + estimate stays under both limits', async () => {
    const db = new FakeCostDb([policy()], [costRecord({ amount: 10 })]);
    const result = await forecastBudget(db, {
      projectId: 'proj-1',
      scope: 'project',
      estimatedCostUsd: 5,
    });
    expect(result?.status).toBe('ok');
    expect(result?.currentSpend).toBe(10);
    expect(result?.projectedSpend).toBe(15);
  });

  it('forecasts a soft_breach the retrospective check would not yet see', async () => {
    // Current spend alone (40) is under the soft limit (50); the estimate (15) pushes the
    // *projected* total over it, which evaluateBudget() cannot detect until after the run.
    const db = new FakeCostDb([policy()], [costRecord({ amount: 40 })]);
    const result = await forecastBudget(db, {
      projectId: 'proj-1',
      scope: 'project',
      estimatedCostUsd: 15,
    });
    expect(result?.status).toBe('soft_breach');
    expect(result?.projectedSpend).toBe(55);
  });

  it('forecasts a hard_breach and hard wins over soft when both are projected to breach', async () => {
    const db = new FakeCostDb([policy()], [costRecord({ amount: 90 })]);
    const result = await forecastBudget(db, {
      projectId: 'proj-1',
      scope: 'project',
      estimatedCostUsd: 50,
    });
    expect(result?.status).toBe('hard_breach');
    expect(result?.projectedSpend).toBe(140);
  });

  it('ignores inactive policies', async () => {
    const db = new FakeCostDb([policy({ is_active: 0 })], []);
    const result = await forecastBudget(db, {
      projectId: 'proj-1',
      scope: 'project',
      estimatedCostUsd: 1000,
    });
    expect(result).toBeNull();
  });

  it('scopes spend to a specific feature when featureRequestId is provided', async () => {
    const db = new FakeCostDb(
      [policy({ scope: 'feature', feature_request_id: 'fr-1' })],
      [
        costRecord({ scope: 'feature', feature_request_id: 'fr-1', amount: 20 }),
        costRecord({ scope: 'feature', feature_request_id: 'fr-2', amount: 1000 }),
      ],
    );
    const result = await forecastBudget(db, {
      projectId: 'proj-1',
      scope: 'feature',
      featureRequestId: 'fr-1',
      estimatedCostUsd: 40,
    });
    expect(result?.currentSpend).toBe(20);
    expect(result?.projectedSpend).toBe(60);
    expect(result?.status).toBe('soft_breach');
  });

  it('respects window_days when computing current spend', async () => {
    const oldRecord = costRecord({
      amount: 200,
      recorded_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const recentRecord = costRecord({ amount: 10 });
    const db = new FakeCostDb([policy({ window_days: 7 })], [oldRecord, recentRecord]);
    const result = await forecastBudget(db, {
      projectId: 'proj-1',
      scope: 'project',
      estimatedCostUsd: 5,
    });
    expect(result?.currentSpend).toBe(10);
    expect(result?.projectedSpend).toBe(15);
    expect(result?.status).toBe('ok');
  });
});
