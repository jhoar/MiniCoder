import type { DbClient } from '@minicoder/core';
import type { Fixture } from './types.js';

export const planningReviewMergeFixture: Fixture = {
  name: 'planning-review-merge',
  description: 'Full happy-path seed: project with approved plan and 5 features ready for execution',

  async setup(db: DbClient, projectId = 'proj-prm'): Promise<void> {
    const specId = `spec-${projectId}`;
    const assessId = `assess-${projectId}`;
    const planId = `plan-${projectId}`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Planning Review Merge Project', 'Default system_test fixture', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO specification_inputs (id, project_id, content, content_type, version, created_at, updated_at)
       VALUES (?, ?, 'Build a complete e-commerce platform with product catalog, cart, and checkout.', 'text/plain', 1, datetime('now'), datetime('now'))`,
      [specId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO planning_readiness_assessments (id, project_id, specification_input_id, status, summary, version, created_at, updated_at)
       VALUES (?, ?, ?, 'sufficient', 'Requirements are complete and unambiguous', 1, datetime('now'), datetime('now'))`,
      [assessId, projectId, specId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, ?, 'approved', 'E-Commerce Platform', 'Full platform with catalog, cart, checkout', 1, datetime('now'), datetime('now'))`,
      [planId, projectId, assessId],
    );

    const features = [
      { frId: 'FR-001', title: 'Product Catalog API' },
      { frId: 'FR-002', title: 'Shopping Cart Service' },
      { frId: 'FR-003', title: 'Checkout Flow' },
      { frId: 'FR-004', title: 'Order Management' },
      { frId: 'FR-005', title: 'Payment Integration' },
    ];

    for (let i = 0; i < features.length; i++) {
      const f = features[i]!;
      const frDbId = `fr-${projectId}-${i + 1}`;
      await db.execute(
        `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'feature', 1, 'approved_pending_execution', ?, 1, datetime('now'), datetime('now'))`,
        [frDbId, planId, projectId, f.frId, f.title, `Implement ${f.title}`, i],
      );
    }

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId],
    );
  },
};
