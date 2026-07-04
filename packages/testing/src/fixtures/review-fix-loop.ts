import type { DbClient } from '@minicoder/core';
import { FeatureExecutionState } from '@minicoder/core';
import type { Fixture } from './types.js';

/**
 * Three feature runs exercising the real Phase 10 review/fix-loop machinery (not raw SQL, unlike
 * the older `review-loop` fixture which this deliberately does not touch):
 *
 * - fr-1 (`FR-101`): at `under_review` with a tracked `pull_requests` row (PR #101), fix_attempt_count=0
 *   — the main request_changes -> fixing -> code_pushed -> under_review -> approve loop.
 * - fr-2 (`FR-102`): at `under_review` with a tracked `pull_requests` row (PR #102),
 *   fix_attempt_count=5 (already at FIX_ATTEMPT_THRESHOLD) — one more `request_changes` cycle
 *   must escalate to `human_required` instead of `changes_requested` (the matrix's guard is
 *   "fix-attempt count < threshold" to allow, ">= threshold" to escalate — see
 *   `RecordChangesRequestedHandler`/`run-review.ts`).
 * - fr-3 (`FR-103`): at `ci_running` with a tracked `pull_requests` row (PR #103), fix_attempt_count=0
 *   — the CI-failure auto-blocking-finding path via `reconcileGithubState`.
 */
export const reviewFixLoopFixture: Fixture = {
  name: 'review-fix-loop',
  description:
    'Three feature runs covering the main review/fix loop, the fix-attempt-threshold escalation, ' +
    'and the CI-failure auto-blocking-finding path',

  async setup(db: DbClient, projectId = 'proj-review-fix-loop'): Promise<void> {
    const planId = `plan-${projectId}`;

    await db.execute(
      `INSERT OR IGNORE INTO projects (id, name, description, state, version, created_at, updated_at)
       VALUES (?, 'Review Fix Loop Project', 'Fixture for review-fix-loop scenario', 'active', 1, datetime('now'), datetime('now'))`,
      [projectId],
    );
    await db.execute(
      `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
       VALUES (?, ?, 'minicoder-test', 'review-fix-loop-repo', 'minicoder-test/review-fix-loop-repo', 'main', 1, datetime('now'), datetime('now'))`,
      [`repo-${projectId}`, projectId],
    );
    await db.execute(
      `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Review Fix Loop Plan', 'Plan for review-fix-loop testing', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );

    async function seedFeatureRun(opts: {
      frId: string;
      suffix: string;
      state: FeatureExecutionState;
      fixAttemptCount: number;
      prNumber: number;
    }): Promise<void> {
      const frDbId = `fr-${projectId}-${opts.suffix}`;
      const runId = `run-${projectId}-${opts.suffix}`;

      await db.execute(
        `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'feature', 1, ?, 0, 1, datetime('now'), datetime('now'))`,
        [
          frDbId,
          planId,
          projectId,
          opts.frId,
          `Feature ${opts.frId}`,
          `Fixture feature for ${opts.frId}`,
          opts.state,
        ],
      );
      await db.execute(
        `INSERT OR IGNORE INTO acceptance_criteria (id, feature_request_id, description, order_index, version, created_at, updated_at)
         VALUES (?, ?, 'Acceptance criterion', 0, 1, datetime('now'), datetime('now'))`,
        [`ac-${frDbId}-1`, frDbId],
      );
      await db.execute(
        `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, fix_attempt_count, started_at, version, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, datetime('now'), 1, datetime('now'), datetime('now'))`,
        [runId, frDbId, opts.state, opts.fixAttemptCount],
      );
      await db.execute(
        `INSERT OR IGNORE INTO pull_requests (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state, ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'main', 'sha-initial', 'open', 'none', 'pending', '[]', 0, 1, datetime('now'), datetime('now'))`,
        [`pr-${runId}`, runId, opts.prNumber, `minicoder/${runId}`],
      );
      await db.execute(
        `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
         VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))
         ON CONFLICT (project_id) DO NOTHING`,
        [`ws-${projectId}`, projectId, runId],
      );
    }

    await seedFeatureRun({
      frId: 'FR-101',
      suffix: '1',
      state: FeatureExecutionState.UNDER_REVIEW,
      fixAttemptCount: 0,
      prNumber: 101,
    });
    await seedFeatureRun({
      frId: 'FR-102',
      suffix: '2',
      state: FeatureExecutionState.UNDER_REVIEW,
      fixAttemptCount: 5,
      prNumber: 102,
    });
    await seedFeatureRun({
      frId: 'FR-103',
      suffix: '3',
      state: FeatureExecutionState.CI_RUNNING,
      fixAttemptCount: 0,
      prNumber: 103,
    });
  },
};
