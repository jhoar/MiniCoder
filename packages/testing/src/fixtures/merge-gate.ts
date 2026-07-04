import type { DbClient } from '@minicoder/core';
import { FeatureExecutionState } from '@minicoder/core';
import type { Fixture } from './types.js';

export const MERGE_GATE_HAPPY_PR_NUMBER = 201;
export const MERGE_GATE_BLOCKED_PR_NUMBER = 202;
export const MERGE_GATE_SHA_MISMATCH_PR_NUMBER = 203;
export const MERGE_GATE_NOT_MERGEABLE_PR_NUMBER = 204;

/**
 * Four feature runs exercising every Merge Gate outcome (docs/06 Phase 12):
 *
 * - FR-201 (`under_review`, clean PR): the happy path all the way to `merged`.
 * - FR-202 (`under_review`, one unresolved blocking finding): the gate must reject.
 * - FR-203 (`approved_by_policy`, clean PR): `merge-if-ready` succeeds, but the real GitHub merge
 *   call is simulated to fail with a `sha_mismatch` (auto-clearable) rejection.
 * - FR-204 (`approved_by_policy`, clean PR): same as FR-203, but the simulated GitHub rejection is
 *   `not_mergeable` (not auto-clearable) — must escalate to `human_required`.
 */
export const mergeGateFixture: Fixture = {
  name: 'merge-gate',
  description:
    'Four feature runs covering every Merge Gate outcome: approve, reject, and both merge-failure classifications',

  async setup(db: DbClient, projectId = 'proj-merge-gate'): Promise<void> {
    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Merge Gate Project', 'Fixture for merge-gate scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
       VALUES (?, ?, 'minicoder-test', 'merge-gate-repo', 'minicoder-test/merge-gate-repo', 'main', 1, datetime('now'), datetime('now'))`,
      [`repo-${projectId}`, projectId],
    );

    const planId = `plan-${projectId}`;
    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Merge Gate Plan', 'Plan for merge gate testing', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );

    await db.execute(
      `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))`,
      [`ws-${projectId}`, projectId, `run-${projectId}-201`],
    );

    const cases: Array<{
      suffix: string;
      frId: string;
      state: FeatureExecutionState;
      prNumber: number;
      hasBlockingFinding: boolean;
    }> = [
      {
        suffix: '201',
        frId: 'FR-201',
        state: FeatureExecutionState.UNDER_REVIEW,
        prNumber: MERGE_GATE_HAPPY_PR_NUMBER,
        hasBlockingFinding: false,
      },
      {
        suffix: '202',
        frId: 'FR-202',
        state: FeatureExecutionState.UNDER_REVIEW,
        prNumber: MERGE_GATE_BLOCKED_PR_NUMBER,
        hasBlockingFinding: true,
      },
      {
        suffix: '203',
        frId: 'FR-203',
        state: FeatureExecutionState.APPROVED_BY_POLICY,
        prNumber: MERGE_GATE_SHA_MISMATCH_PR_NUMBER,
        hasBlockingFinding: false,
      },
      {
        suffix: '204',
        frId: 'FR-204',
        state: FeatureExecutionState.APPROVED_BY_POLICY,
        prNumber: MERGE_GATE_NOT_MERGEABLE_PR_NUMBER,
        hasBlockingFinding: false,
      },
    ];

    for (const c of cases) {
      const featureRequestId = `fr-${projectId}-${c.suffix}`;
      const featureRunId = `run-${projectId}-${c.suffix}`;
      const pullRequestId = `pr-${projectId}-${c.suffix}`;

      await db.execute(
        `INSERT OR IGNORE INTO feature_requests
           (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'Feature under merge-gate test', 'feature', 1, ?, 0, 1, datetime('now'), datetime('now'))`,
        [featureRequestId, planId, projectId, c.frId, `Feature ${c.frId}`, c.state],
      );

      await db.execute(
        `INSERT OR IGNORE INTO feature_runs
           (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
         VALUES (?, ?, 1, ?, datetime('now'), 1, datetime('now'), datetime('now'))`,
        [featureRunId, featureRequestId, c.state],
      );

      await db.execute(
        `INSERT OR IGNORE INTO pull_requests
           (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
            ci_status, mergeable, blocking_labels, conversations_resolved, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'main', ?, 'open', 'approved', 'passed', 1, '[]', 0, 1, datetime('now'), datetime('now'))`,
        [pullRequestId, featureRunId, c.prNumber, `minicoder/${c.frId}`, `${c.suffix}-headsha`],
      );

      if (c.hasBlockingFinding) {
        await db.execute(
          `INSERT OR IGNORE INTO review_findings
             (id, feature_run_id, review_cycle, severity, description, resolved, version, created_at, updated_at)
           VALUES (?, ?, 1, 'blocking', 'Unresolved blocking finding for merge-gate test', FALSE, 1, datetime('now'), datetime('now'))`,
          [`finding-${projectId}-${c.suffix}`, featureRunId],
        );
      }
    }
  },
};
