import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import type { DbClient } from '@minicoder/core';
import { listDisagreements } from './governance.js';

async function seedProject(db: DbClient, projectId: string): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
    [projectId],
  );
}

async function seedFeatureRun(
  db: DbClient,
  opts: { projectId: string; featureRequestId: string; featureRunId: string; frId: string },
): Promise<void> {
  const planId = `plan-${opts.featureRequestId}`;
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, state, title, version, created_at, updated_at)
     VALUES (?, ?, 'activated_for_execution', 'Test Plan', 1, datetime('now'), datetime('now'))`,
    [planId, opts.projectId],
  );
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Test Feature', 'A test feature.', 'feature', 1, 'approved_pending_execution', 0, 1, datetime('now'), datetime('now'))`,
    [opts.featureRequestId, planId, opts.projectId, opts.frId],
  );
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
     VALUES (?, ?, 1, 'human_required', 1, datetime('now'), datetime('now'))`,
    [opts.featureRunId, opts.featureRequestId],
  );
}

async function seedDisagreement(
  db: DbClient,
  opts: { id: string; featureRunId: string; state?: string },
): Promise<void> {
  await db.execute(
    `INSERT INTO disagreement_records (id, feature_run_id, review_cycle, state, version, created_at, updated_at)
     VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
    [opts.id, opts.featureRunId, opts.state ?? 'open'],
  );
}

describe('listDisagreements', () => {
  // Regression for issue #63 / MEDIUM-6: the Web UI used to resolve a disagreement's feature
  // request ID and project ID with one `getFeatureRun`/`getFeature` HTTP round-trip pair *per row*
  // (an O(n) render-time fan-out). This proves the read model itself now resolves both fields via
  // two fixed batch queries, and — using deliberately distinct run/request/project IDs across two
  // unrelated disagreements — that the batch-map resolution doesn't cross-wire results between rows.
  it("resolves each disagreement to its own feature_request_id and project_id, not a sibling row's", async () => {
    const db = createTestDb() as unknown as DbClient;
    await seedProject(db, 'project-alpha');
    await seedProject(db, 'project-beta');
    await seedFeatureRun(db, {
      projectId: 'project-alpha',
      featureRequestId: 'feature-req-alpha',
      featureRunId: 'run-alpha',
      frId: 'FR-001',
    });
    await seedFeatureRun(db, {
      projectId: 'project-beta',
      featureRequestId: 'feature-req-beta',
      featureRunId: 'run-beta',
      frId: 'FR-002',
    });
    await seedDisagreement(db, { id: 'disagreement-alpha', featureRunId: 'run-alpha' });
    await seedDisagreement(db, { id: 'disagreement-beta', featureRunId: 'run-beta' });

    const page = await listDisagreements(db, {}, {});

    expect(page.items).toHaveLength(2);
    const alpha = page.items.find((d) => d.id === 'disagreement-alpha');
    const beta = page.items.find((d) => d.id === 'disagreement-beta');
    expect(alpha).toMatchObject({
      feature_run_id: 'run-alpha',
      feature_request_id: 'feature-req-alpha',
      project_id: 'project-alpha',
    });
    expect(beta).toMatchObject({
      feature_run_id: 'run-beta',
      feature_request_id: 'feature-req-beta',
      project_id: 'project-beta',
    });
  });

  it('filters by featureRunId and state while still resolving feature_request_id/project_id', async () => {
    const db = createTestDb() as unknown as DbClient;
    await seedProject(db, 'project-gamma');
    await seedFeatureRun(db, {
      projectId: 'project-gamma',
      featureRequestId: 'feature-req-gamma',
      featureRunId: 'run-gamma',
      frId: 'FR-003',
    });
    await seedDisagreement(db, {
      id: 'disagreement-open',
      featureRunId: 'run-gamma',
      state: 'open',
    });
    await seedDisagreement(db, {
      id: 'disagreement-resolved',
      featureRunId: 'run-gamma',
      state: 'resolved',
    });

    const page = await listDisagreements(db, { featureRunId: 'run-gamma', state: 'open' }, {});

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: 'disagreement-open',
      feature_request_id: 'feature-req-gamma',
      project_id: 'project-gamma',
    });
  });

  it('returns an empty page (no batch queries needed) when there are no disagreements', async () => {
    const db = createTestDb() as unknown as DbClient;
    const page = await listDisagreements(db, {}, {});
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
