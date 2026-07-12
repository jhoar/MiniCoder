import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import type { DbClient } from '@minicoder/core';
import { getBudgetReport } from './budget-report.js';

async function seedProject(db: DbClient, projectId: string): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
    [projectId],
  );
}

async function seedCostRecord(
  db: DbClient,
  id: string,
  overrides: {
    projectId: string;
    scope: string;
    amount: number;
    provider?: string | null;
    model?: string | null;
    recordedAt?: string;
  },
): Promise<void> {
  await db.execute(
    `INSERT INTO cost_records (id, project_id, scope, amount, currency, provider, model, recorded_at, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    [
      id,
      overrides.projectId,
      overrides.scope,
      overrides.amount,
      overrides.provider ?? null,
      overrides.model ?? null,
      overrides.recordedAt ?? new Date().toISOString(),
    ],
  );
}

describe('getBudgetReport', () => {
  it('aggregates total spend and per-scope/provider/model breakdowns', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-budget-report-1';
    await seedProject(db, projectId);
    await seedCostRecord(db, 'cr-1', {
      projectId,
      scope: 'project',
      amount: 10,
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    await seedCostRecord(db, 'cr-2', {
      projectId,
      scope: 'feature',
      amount: 25,
      provider: 'openai',
      model: 'gpt-4o',
    });

    const report = await getBudgetReport(db, { projectId });
    expect(report.totalAmount).toBe(35);
    expect(report.recordCount).toBe(2);
    expect(report.byScope.find((r) => r.key === 'project')?.totalAmount).toBe(10);
    expect(report.byScope.find((r) => r.key === 'feature')?.totalAmount).toBe(25);
    expect(report.byProvider.find((r) => r.key === 'openai')?.totalAmount).toBe(35);
    expect(report.byModel.map((r) => r.key).sort()).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('respects windowDays, excluding older cost_records', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-budget-report-2';
    await seedProject(db, projectId);
    const oldTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await seedCostRecord(db, 'cr-old', {
      projectId,
      scope: 'project',
      amount: 100,
      recordedAt: oldTs,
    });
    await seedCostRecord(db, 'cr-new', { projectId, scope: 'project', amount: 5 });

    const report = await getBudgetReport(db, { projectId, windowDays: 7 });
    expect(report.totalAmount).toBe(5);
    expect(report.recordCount).toBe(1);
  });

  it('isolates spend by project', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectA = 'proj-budget-report-a';
    const projectB = 'proj-budget-report-b';
    await seedProject(db, projectA);
    await seedProject(db, projectB);
    await seedCostRecord(db, 'cr-a', { projectId: projectA, scope: 'project', amount: 10 });
    await seedCostRecord(db, 'cr-b', { projectId: projectB, scope: 'project', amount: 999 });

    const report = await getBudgetReport(db, { projectId: projectA });
    expect(report.totalAmount).toBe(10);
  });

  it('reports zero totals with no cost_records', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-budget-report-empty';
    await seedProject(db, projectId);

    const report = await getBudgetReport(db, { projectId });
    expect(report.totalAmount).toBe(0);
    expect(report.recordCount).toBe(0);
    expect(report.byScope).toEqual([]);
  });
});
