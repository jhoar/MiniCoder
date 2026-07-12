import type { DbClient } from '@minicoder/core';
import type { Fixture } from './types.js';

/**
 * A project with one feature run already `merged` (so `evaluateProjectAcceptance()` sees a clean
 * project — every real check this fixture can satisfy without a live GitHub/CI credential) and a
 * `workflow_states` row (`MarkImplementationCompleteHandler`'s downstream handlers don't strictly
 * need it, but a real production project always has one). Exercises the full Phase 17
 * `active -> ... -> project_complete` project-lifecycle chain.
 */
export const designDocumentLifecycleFixture: Fixture = {
  name: 'design-document-lifecycle',
  description:
    'Project at active with one merged feature run, ready for Project Acceptance Validation',

  async setup(db: DbClient, projectId = 'proj-design-doc-lifecycle'): Promise<void> {
    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Design Document Lifecycle Project', 'Fixture for design-document-lifecycle scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    const planId = `plan-${projectId}`;
    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Design Doc Lifecycle Plan', 'Plan for design-document-lifecycle testing', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId],
    );

    const featureRequestId = `fr-${projectId}-001`;
    const featureRunId = `run-${projectId}-001`;
    await db.execute(
      `INSERT OR IGNORE INTO feature_requests
         (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'Feature One', 'Feature already merged for design-document-lifecycle test', 'feature', 1, 'merged', 0, 1, datetime('now'), datetime('now'))`,
      [featureRequestId, planId, projectId],
    );
    await db.execute(
      `INSERT OR IGNORE INTO feature_runs
         (id, feature_request_id, attempt_no, current_execution_state, started_at, ended_at, version, created_at, updated_at)
       VALUES (?, ?, 1, 'merged', datetime('now'), datetime('now'), 1, datetime('now'), datetime('now'))`,
      [featureRunId, featureRequestId],
    );

    const pullRequestId = `pr-${projectId}-001`;
    await db.execute(
      `INSERT OR IGNORE INTO pull_requests
         (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
          ci_status, mergeable, blocking_labels, conversations_resolved, merged_at, merge_sha, version, created_at, updated_at)
       VALUES (?, ?, 301, 'minicoder/FR-001', 'main', 'headsha-001', 'merged', 'approved', 'passed', 1, '[]', FALSE, datetime('now'), 'mergesha-001', 1, datetime('now'), datetime('now'))`,
      [pullRequestId, featureRunId],
    );
  },
};
