import { describe, it, expect } from 'vitest';
import { InboxProcessor } from '@minicoder/workflow';
import {
  createGithubInboxHandlers,
  normalizeGithubWebhookEvent,
  resolveFeatureRunId,
} from '@minicoder/github';
import { FeatureExecutionState, SCHEMA_VERSION } from '@minicoder/core';
import { MockGitHubProvider } from './services/mock-github-provider.js';
import { MockGitHubClient } from './services/mock-github-client.js';
import { createTestDb } from './db.js';

const PROJECT_ID = 'proj-inbox-e2e';

async function seed(db: ReturnType<typeof createTestDb>): Promise<{ featureRunId: string }> {
  await db.execute(
    `INSERT INTO projects (id, name, description, state, version, created_at, updated_at)
     VALUES (?, 'Inbox E2E Project', 'x', 'active', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
     VALUES ('repo-1', ?, 'acme', 'widgets', 'acme/widgets', 'main', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES ('plan-1', ?, NULL, 'activated_for_execution', 'Plan', 'x', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES ('fr-1', 'plan-1', ?, 'FR-001', 'Feature', 'x', 'feature', 1, 'approved_pending_execution', 0, 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
  const featureRunId = 'run-1';
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
     VALUES (?, 'fr-1', 1, ?, datetime('now'), 1, datetime('now'), datetime('now'))`,
    [featureRunId, FeatureExecutionState.CODE_PUSHED],
  );
  return { featureRunId };
}

async function insertInboxEvent(
  db: ReturnType<typeof createTestDb>,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.execute(
    `INSERT INTO inbox_events (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
     VALUES (?, ?, 'github', ?, ?, ?, 'pending', 1, datetime('now'), datetime('now'))`,
    [
      `delivery-${eventType}-${Date.now()}-${Math.random()}`,
      `delivery-${eventType}-${Date.now()}-${Math.random()}`,
      eventType,
      JSON.stringify(payload),
      SCHEMA_VERSION,
    ],
  );
}

describe('GitHub webhook → InboxProcessor → reconcileGithubState (end-to-end)', () => {
  it('advances code_pushed -> pr_opened via a pr.opened inbox event resolved by branch name', async () => {
    const db = createTestDb();
    const { featureRunId } = await seed(db);
    const provider = new MockGitHubProvider();
    provider.simulatePrOpened(101, featureRunId, 'sha-abc');

    const client = new MockGitHubClient(provider);
    const handlers = createGithubInboxHandlers(db, async () => client);
    const processor = new InboxProcessor(db, handlers);

    await insertInboxEvent(db, 'pr.opened', {
      projectId: PROJECT_ID,
      prNumber: 101,
      branchName: 'minicoder/FR-001',
      baseBranch: 'main',
      headSha: 'sha-abc',
    });

    const result = await processor.pollAndProcess();
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.PR_OPENED);
  });

  it('advances ci_running -> under_review via a check.passed inbox event resolved by tracked PR number', async () => {
    const db = createTestDb();
    const { featureRunId } = await seed(db);
    await db.execute(`UPDATE feature_runs SET current_execution_state = ? WHERE id = ?`, [
      FeatureExecutionState.CI_RUNNING,
      featureRunId,
    ]);
    await db.execute(
      `INSERT INTO pull_requests
         (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
          ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
       VALUES ('pr-1', ?, 102, 'minicoder/FR-001', 'main', 'sha-def', 'open', 'none', 'running', '[]', 0, 1, datetime('now'), datetime('now'))`,
      [featureRunId],
    );

    const provider = new MockGitHubProvider();
    provider.simulatePrOpened(102, featureRunId, 'sha-def');
    provider.simulateCheckPassed(102, 'check-1');

    const client = new MockGitHubClient(provider);
    const handlers = createGithubInboxHandlers(db, async () => client);
    const processor = new InboxProcessor(db, handlers);

    await insertInboxEvent(db, 'check.passed', { projectId: PROJECT_ID, prNumber: 102 });

    const result = await processor.pollAndProcess();
    expect(result.processed).toBe(1);

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.UNDER_REVIEW);
  });

  it('HIGH-4: a legacy status-derived check.passed event with prNumber: null resolves the run via head_sha', async () => {
    const db = createTestDb();
    const { featureRunId } = await seed(db);
    await db.execute(`UPDATE feature_runs SET current_execution_state = ? WHERE id = ?`, [
      FeatureExecutionState.CI_RUNNING,
      featureRunId,
    ]);
    await db.execute(
      `INSERT INTO pull_requests
         (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
          ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
       VALUES ('pr-1', ?, 103, 'minicoder/FR-001', 'main', 'sha-status', 'open', 'none', 'running', '[]', 0, 1, datetime('now'), datetime('now'))`,
      [featureRunId],
    );

    const provider = new MockGitHubProvider();
    provider.simulatePrOpened(103, featureRunId, 'sha-status');
    provider.simulateCheckPassed(103, 'legacy-status');

    const client = new MockGitHubClient(provider);
    const handlers = createGithubInboxHandlers(db, async () => client);
    const processor = new InboxProcessor(db, handlers);

    // Mirrors normalize.ts's `status` webhook case: prNumber is always null, only sha is known.
    await insertInboxEvent(db, 'check.passed', {
      projectId: PROJECT_ID,
      prNumber: null,
      sha: 'sha-status',
    });

    const result = await processor.pollAndProcess();
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.UNDER_REVIEW);
  });

  it('code-review round 3 HIGH-5: a realistic push webhook (ref + after) normalizes and resolves to the tracked feature run end-to-end', async () => {
    const db = createTestDb();
    const { featureRunId } = await seed(db);
    // A push mid-fix-cycle lands on a PR already tracked by pull_requests — resolveFeatureRunId's
    // branch-name lookup pairs the resolved feature run with its already-known PR number.
    await db.execute(
      `INSERT INTO pull_requests
         (id, feature_run_id, pr_number, branch_name, base_branch, head_sha, state, review_state,
          ci_status, blocking_labels, conversations_resolved, version, created_at, updated_at)
       VALUES ('pr-1', ?, 105, 'minicoder/FR-001', 'main', 'sha-push-0', 'open', 'none', 'passed', '[]', 0, 1, datetime('now'), datetime('now'))`,
      [featureRunId],
    );

    // A realistic raw GitHub push webhook body: no `sha` field, only `ref` and `after`. The
    // normalizer must strip `refs/heads/` and emit `branchName`/`sha`, and resolveFeatureRunId
    // must resolve that branchName to the tracked feature run (existing behavior for
    // pr.opened's branchName field, now exercised for a normalizer-produced push payload too).
    const normalized = normalizeGithubWebhookEvent('push', {
      repository: { full_name: 'acme/widgets' },
      ref: 'refs/heads/minicoder/FR-001',
      after: 'sha-push-1',
    });
    expect(normalized?.eventType).toBe('push');
    expect(normalized?.payload).toEqual({ branchName: 'minicoder/FR-001', sha: 'sha-push-1' });

    const resolved = await resolveFeatureRunId(db, {
      projectId: PROJECT_ID,
      prNumber: normalized!.payload.prNumber as number | null,
      branchName: normalized!.payload.branchName as string,
      sha: normalized!.payload.sha as string,
    });

    expect(resolved?.featureRunId).toBe(featureRunId);
  });

  it('HIGH-3: retries with a freshly acquired lock and completes the transition when the no-lock fast path hits lock_required', async () => {
    const db = createTestDb();
    const { featureRunId } = await seed(db);
    // `seed()` already leaves the feature run at CODE_PUSHED — a lock-gated state
    // (`requiresExecutionLock`). Wrap `db.query` so the inbox handler's cheap `needsLock`
    // pre-check (the simple `SELECT current_execution_state FROM feature_runs WHERE id = ?` in
    // packages/github/src/inbox-handlers.ts) observes a stale, non-lock-gated snapshot exactly
    // once — simulating the narrow race HIGH-3 targets: a concurrent writer advances the run into
    // a lock-gated state between the handler's pre-check and `reconcileGithubState`'s own internal
    // read (a different, JOIN-based query, left untouched here so it sees the *real* row).
    let interceptedOnce = false;
    // A transparent Proxy (not an object spread) — `query`/`execute`/`transaction` are prototype
    // methods on `SqliteDbClient`, so a spread copy would silently drop them. The proxy forwards
    // every property/method through to the real `db` unchanged except `query`, which is
    // intercepted exactly once for the specific stale-snapshot read.
    const racyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return async (sql: string, params?: unknown[]) => {
            if (
              !interceptedOnce &&
              sql.includes('SELECT current_execution_state FROM feature_runs WHERE id = ?')
            ) {
              interceptedOnce = true;
              return [{ current_execution_state: FeatureExecutionState.UNDER_REVIEW }];
            }
            return target.query(sql, params);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    const provider = new MockGitHubProvider();
    provider.simulatePrOpened(106, featureRunId, 'sha-race');

    const client = new MockGitHubClient(provider);
    const handlers = createGithubInboxHandlers(racyDb, async () => client);
    const processor = new InboxProcessor(db, handlers);

    await insertInboxEvent(db, 'pr.opened', {
      projectId: PROJECT_ID,
      prNumber: 106,
      branchName: 'minicoder/FR-001',
      baseBranch: 'main',
      headSha: 'sha-race',
    });

    const result = await processor.pollAndProcess();
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(interceptedOnce).toBe(true);

    // The transition still completed via the retry-with-lock path, not left stuck.
    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.PR_OPENED);
  });

  it.each(['review.comment', 'review.commented', 'push', 'branch.protection_ok'])(
    'HIGH-5: a %s inbox event ends up processed, not stuck pending',
    async (eventType) => {
      const db = createTestDb();
      const { featureRunId } = await seed(db);

      const provider = new MockGitHubProvider();
      provider.simulatePrOpened(104, featureRunId, 'sha-branch');

      const client = new MockGitHubClient(provider);
      const handlers = createGithubInboxHandlers(db, async () => client);
      const processor = new InboxProcessor(db, handlers);

      await insertInboxEvent(db, eventType, {
        projectId: PROJECT_ID,
        prNumber: null,
        branchName: 'minicoder/FR-001',
      });

      const result = await processor.pollAndProcess();
      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);

      const rows = await db.query<{ status: string }>(
        `SELECT status FROM inbox_events WHERE event_type = ?`,
        [eventType],
      );
      expect(rows[0]?.status).toBe('processed');
    },
  );
});
