import { describe, it, expect } from 'vitest';
import {
  insertPullRequestRow,
  syncPullRequestObservedState,
  labelsEqual,
  timestampsEqual,
} from '@minicoder/core';
import type { ObservedPullRequestState } from '@minicoder/core';
import { createTestDb } from './db.js';

const PROJECT_ID = 'proj-pr-row-test';

async function seedProject(db: ReturnType<typeof createTestDb>): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, description, state, version, created_at, updated_at)
     VALUES (?, 'PR Row Test Project', 'x', 'active', 1, datetime('now'), datetime('now'))`,
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
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, started_at, version, created_at, updated_at)
     VALUES ('run-1', 'fr-1', 1, 'code_pushed', datetime('now'), 1, datetime('now'), datetime('now'))`,
  );
}

function observed(overrides: Partial<ObservedPullRequestState> = {}): ObservedPullRequestState {
  return {
    prNumber: 50,
    branchName: 'minicoder/FR-001',
    baseBranch: 'main',
    headSha: 'sha1',
    state: 'open',
    reviewState: 'none',
    ciStatus: 'pending',
    mergeable: true,
    blockingLabels: [],
    conversationsResolved: true,
    mergedAt: null,
    mergeSha: null,
    closedAt: null,
    ...overrides,
  };
}

describe('syncPullRequestObservedState (MEDIUM-1 idempotency)', () => {
  it('leaves version/updated_at unchanged on a second call with identical observed state', async () => {
    const db = createTestDb();
    await seedProject(db);
    await db.transaction(async (tx) => {
      await insertPullRequestRow(tx, {
        id: 'pr-row-1',
        featureRunId: 'run-1',
        prNumber: 50,
        branchName: 'minicoder/FR-001',
        baseBranch: 'main',
        headSha: 'sha1',
      });
    });

    const state = observed();
    await db.transaction(async (tx) => {
      await syncPullRequestObservedState(tx, 'run-1', state);
    });
    const afterFirst = (
      await db.query<{ version: number; updated_at: string }>(
        `SELECT version, updated_at FROM pull_requests WHERE feature_run_id = 'run-1'`,
      )
    )[0]!;

    // Second call with the exact same observed state — must be a true no-op.
    await db.transaction(async (tx) => {
      await syncPullRequestObservedState(tx, 'run-1', state);
    });
    const afterSecond = (
      await db.query<{ version: number; updated_at: string }>(
        `SELECT version, updated_at FROM pull_requests WHERE feature_run_id = 'run-1'`,
      )
    )[0]!;

    expect(afterSecond.version).toBe(afterFirst.version);
    expect(afterSecond.updated_at).toBe(afterFirst.updated_at);
  });

  it('updates version when a field genuinely changes', async () => {
    const db = createTestDb();
    await seedProject(db);
    await db.transaction(async (tx) => {
      await insertPullRequestRow(tx, {
        id: 'pr-row-2',
        featureRunId: 'run-1',
        prNumber: 50,
        branchName: 'minicoder/FR-001',
        baseBranch: 'main',
        headSha: 'sha1',
      });
    });

    await db.transaction(async (tx) => {
      await syncPullRequestObservedState(tx, 'run-1', observed());
    });
    const afterFirst = (
      await db.query<{ version: number }>(
        `SELECT version FROM pull_requests WHERE feature_run_id = 'run-1'`,
      )
    )[0]!;

    await db.transaction(async (tx) => {
      await syncPullRequestObservedState(tx, 'run-1', observed({ ciStatus: 'passed' }));
    });
    const afterSecond = (
      await db.query<{ version: number; ci_status: string }>(
        `SELECT version, ci_status FROM pull_requests WHERE feature_run_id = 'run-1'`,
      )
    )[0]!;

    expect(afterSecond.version).toBeGreaterThan(afterFirst.version);
    expect(afterSecond.ci_status).toBe('passed');
  });

  it('is a no-op when no pull_requests row exists yet', async () => {
    const db = createTestDb();
    await seedProject(db);

    await expect(
      db.transaction(async (tx) => {
        await syncPullRequestObservedState(tx, 'run-1', observed());
      }),
    ).resolves.not.toThrow();

    const rows = await db.query(`SELECT 1 FROM pull_requests WHERE feature_run_id = 'run-1'`);
    expect(rows).toHaveLength(0);
  });
});

/**
 * MEDIUM-1 code-review fix: on PostgreSQL, `blocking_labels` (JSONB) round-trips through `pg` as
 * an already-parsed JS array (not the JSON string SQLite's driver returns), and
 * `merged_at`/`closed_at` (TIMESTAMPTZ) round-trip as `Date` objects (not ISO strings). A plain
 * `existing === JSON.stringify(observed)` / `existing === observed` comparison — what
 * `syncPullRequestObservedState`'s diff-check used before this fix — never matches on those
 * Postgres-shaped values, so two consecutive reconciliations with identical observed state would
 * churn `version`/`updated_at` forever on PostgreSQL even though the round-3 fix already made
 * SQLite idempotent. `labelsEqual`/`timestampsEqual` are the normalizing comparators that fix
 * this; exercised directly here against both SQLite-shaped and Postgres-shaped inputs.
 */
describe('labelsEqual / timestampsEqual (MEDIUM-1 cross-dialect normalization)', () => {
  it('labelsEqual: matches a SQLite-shaped JSON string against the observed array', () => {
    expect(labelsEqual('["wip","do-not-merge"]', ['wip', 'do-not-merge'])).toBe(true);
  });

  it('labelsEqual: matches a Postgres-shaped already-parsed array against the observed array', () => {
    expect(labelsEqual(['wip', 'do-not-merge'], ['wip', 'do-not-merge'])).toBe(true);
  });

  it('labelsEqual: detects a genuine difference regardless of existing-value shape', () => {
    expect(labelsEqual('["wip"]', ['wip', 'do-not-merge'])).toBe(false);
    expect(labelsEqual(['wip'], ['wip', 'do-not-merge'])).toBe(false);
  });

  it('timestampsEqual: matches a SQLite-shaped ISO string against the observed ISO string', () => {
    expect(timestampsEqual('2024-03-01T12:00:00.000Z', '2024-03-01T12:00:00.000Z')).toBe(true);
  });

  it('timestampsEqual: matches a Postgres-shaped Date object against the observed ISO string', () => {
    expect(timestampsEqual(new Date('2024-03-01T12:00:00.000Z'), '2024-03-01T12:00:00.000Z')).toBe(
      true,
    );
  });

  it('timestampsEqual: both-null compares equal', () => {
    expect(timestampsEqual(null, null)).toBe(true);
  });

  it('timestampsEqual: one-null-one-set compares unequal', () => {
    expect(timestampsEqual(null, '2024-03-01T12:00:00.000Z')).toBe(false);
    expect(timestampsEqual(new Date('2024-03-01T12:00:00.000Z'), null)).toBe(false);
  });

  it('timestampsEqual: detects a genuine difference regardless of existing-value shape', () => {
    expect(timestampsEqual('2024-03-01T12:00:00.000Z', '2024-03-02T00:00:00.000Z')).toBe(false);
    expect(timestampsEqual(new Date('2024-03-01T12:00:00.000Z'), '2024-03-02T00:00:00.000Z')).toBe(
      false,
    );
  });
});

describe('syncPullRequestObservedState (MEDIUM-1 idempotency, Postgres-shaped-equivalent fields)', () => {
  it('leaves version/updated_at unchanged on a second call after writing labels/mergedAt observed via the DB round trip', async () => {
    const db = createTestDb();
    await seedProject(db);
    await db.transaction(async (tx) => {
      await insertPullRequestRow(tx, {
        id: 'pr-row-3',
        featureRunId: 'run-1',
        prNumber: 50,
        branchName: 'minicoder/FR-001',
        baseBranch: 'main',
        headSha: 'sha1',
      });
    });

    const state = observed({
      mergedAt: '2024-03-01T12:00:00.000Z',
      blockingLabels: ['do-not-merge', 'wip'],
    });
    await db.transaction(async (tx) => {
      await syncPullRequestObservedState(tx, 'run-1', state);
    });
    const afterFirst = (
      await db.query<{ version: number; updated_at: string }>(
        `SELECT version, updated_at FROM pull_requests WHERE feature_run_id = 'run-1'`,
      )
    )[0]!;

    // Second call with the exact same observed state — must be a true no-op even though this row
    // now carries the JSONB/TIMESTAMPTZ-shaped fields MEDIUM-1 was about (SQLite's driver returns
    // string-shaped values for both here; `labelsEqual`/`timestampsEqual`'s Postgres-shaped
    // handling is covered directly in the describe block above since this test harness only runs
    // against SQLite).
    await db.transaction(async (tx) => {
      await syncPullRequestObservedState(tx, 'run-1', state);
    });
    const afterSecond = (
      await db.query<{ version: number; updated_at: string }>(
        `SELECT version, updated_at FROM pull_requests WHERE feature_run_id = 'run-1'`,
      )
    )[0]!;

    expect(afterSecond.version).toBe(afterFirst.version);
    expect(afterSecond.updated_at).toBe(afterFirst.updated_at);
  });
});
