/**
 * Stage 4 acceptance regression (docs/06 §Phase 18): proves that the scheduled reconciliation
 * fallback — not a webhook — is what advances a GitLab-backed feature run out of `under_review`
 * when GitLab reports insufficient approvals plus an unresolved review discussion.
 *
 * `@minicoder/gitlab`'s `normalize.ts` never produces `review.changes_requested` (GitLab has no
 * webhook event for it — see that module's own doc comment and its
 * `normalize.test.ts`'s "never produces review.changes_requested" test). The *only* way this
 * condition is ever discovered is a fresh `GitlabScmClient.getPullRequest()` observation feeding
 * `reconcileGithubState()` — exactly what the scheduled `github-reconciliation` task does on its
 * own polling cadence, independent of any webhook delivery. This test calls
 * `reconcileGithubState()` directly with an `ObservedPullRequestState` built from
 * `@minicoder/gitlab`'s own `deriveReviewState()`/`deriveConversationsResolved()` — the exact
 * synthesis `GitlabScmClient.getPullRequest()` performs — to prove the algorithm correctly
 * advances the run using only that fetched-state input, with no webhook payload anywhere in the
 * call path.
 */
import { describe, it, expect } from 'vitest';
import { reconcileGithubState, FeatureExecutionState } from '@minicoder/core';
import type { ObservedPullRequestState } from '@minicoder/core';
import { deriveReviewState, deriveConversationsResolved } from '@minicoder/gitlab';
import { createTestDb } from './db.js';

const PROJECT_ID = 'proj-gitlab-reconcile-fallback';

async function seedProject(db: ReturnType<typeof createTestDb>): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, description, state, version, created_at, updated_at)
     VALUES (?, 'GitLab Fallback Test Project', 'x', 'active', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO repositories (id, project_id, owner, name, full_name, default_branch, provider, version, created_at, updated_at)
     VALUES ('repo-gitlab-1', ?, 'acme', 'widgets', 'acme/widgets', 'main', 'gitlab', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES ('plan-gitlab-1', ?, NULL, 'activated_for_execution', 'Plan', 'x', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
}

async function seedFeatureRun(
  db: ReturnType<typeof createTestDb>,
): Promise<{ featureRequestId: string; featureRunId: string }> {
  const featureRequestId = 'fr-gitlab-1';
  const featureRunId = 'run-gitlab-1';
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, 'plan-gitlab-1', ?, 'FR-001', 'Feature', 'x', 'feature', 1, 'approved_pending_execution', 0, 1, datetime('now'), datetime('now'))`,
    [featureRequestId, PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
     VALUES (?, ?, 1, ?, datetime('now'), 1, datetime('now'), datetime('now'))`,
    [featureRunId, featureRequestId, FeatureExecutionState.UNDER_REVIEW],
  );
  await db.execute(
    `INSERT INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))`,
    [`ws-${PROJECT_ID}`, PROJECT_ID, featureRunId],
  );
  return { featureRequestId, featureRunId };
}

async function seedPullRequestRow(
  db: ReturnType<typeof createTestDb>,
  featureRunId: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO pull_requests
       (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
        ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
     VALUES (?, ?, 21, 'minicoder/FR-001', 'main', 'sha-gitlab-1', 'open', 'approved',
             'passed', '[]', 1, 1, datetime('now'), datetime('now'))`,
    [`pr-${featureRunId}`, featureRunId],
  );
}

async function seedLock(
  db: ReturnType<typeof createTestDb>,
): Promise<{ lockId: string; fence: number; holderId: string; resourceKey: string }> {
  const lockId = `lock-${PROJECT_ID}`;
  const holderId = 'test-holder';
  const resourceKey = `execution-lane:${PROJECT_ID}`;
  await db.execute(
    `INSERT INTO workflow_locks (id, project_id, resource_key, holder_id, fence, expires_at, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
    [lockId, PROJECT_ID, resourceKey, holderId, new Date(Date.now() + 60_000).toISOString()],
  );
  return { lockId, fence: 1, holderId, resourceKey };
}

describe('GitLab reconciliation fallback (Stage 4 acceptance)', () => {
  it('the review-state synthesis alone reports CHANGES_REQUESTED for insufficient-approvals-was-fine-but-an-unresolved-discussion-exists', () => {
    // Sanity-checks the exact synthesis GitlabScmClient.getPullRequest() performs, before proving
    // reconcileGithubState() acts on it below.
    const reviewState = deriveReviewState({ approvals_required: 1, approvals_left: 0 }, [
      { notes: [{ resolvable: true, resolved: false }] },
    ]);
    expect(reviewState).toBe('changes_requested');
    expect(deriveConversationsResolved([{ notes: [{ resolvable: true, resolved: false }] }])).toBe(
      false,
    );
  });

  it('reconcileGithubState() advances under_review -> changes_requested -> fixing from a freshly-fetched GitLab observation alone, with no webhook payload in the call path', async () => {
    const db = createTestDb();
    await seedProject(db);
    const { featureRunId } = await seedFeatureRun(db);
    await seedPullRequestRow(db, featureRunId);
    const lockContext = await seedLock(db);

    // This is exactly what GitlabScmClient.getPullRequest() would have returned for an MR GitLab
    // reports as fully approved but with one unresolved review discussion — the condition no
    // GitLab webhook can ever carry (normalize.test.ts's "never produces
    // review.changes_requested" test proves the webhook side of this gap).
    const observed: ObservedPullRequestState = {
      prNumber: 21,
      branchName: 'minicoder/FR-001',
      baseBranch: 'main',
      headSha: 'sha-gitlab-2',
      state: 'open',
      reviewState: deriveReviewState({ approvals_required: 1, approvals_left: 0 }, [
        { notes: [{ resolvable: true, resolved: false }] },
      ]),
      ciStatus: 'passed',
      mergeable: true,
      blockingLabels: [],
      conversationsResolved: deriveConversationsResolved([
        { notes: [{ resolvable: true, resolved: false }] },
      ]),
      mergedAt: null,
      mergeSha: null,
      closedAt: null,
    };

    const result = await reconcileGithubState({
      db,
      featureRunId,
      projectId: PROJECT_ID,
      observed,
      correlationId: 'gitlab-fallback-1',
      lockContext,
    });

    expect(result.actions).toEqual(['changes_requested', 'fixing_started']);
    expect(result.resultingState).toBe(FeatureExecutionState.FIXING);

    const rows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(rows[0]?.current_execution_state).toBe(FeatureExecutionState.FIXING);
  });
});
