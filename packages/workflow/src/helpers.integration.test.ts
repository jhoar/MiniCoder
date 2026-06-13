/**
 * Integration tests for packages/core/src/commands/helpers.ts
 * using a real SQLite database to verify SQL correctness.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteDbClient } from '@minicoder/persistence-sqlite';
import { claimIdempotencyKey, fulfillIdempotencyKey, assertLockFence } from '@minicoder/core';
import { StaleFenceError } from '@minicoder/core';
import { createTestDb, insertTestProject } from './test-helpers.js';

let db: SqliteDbClient;
let raw: Database.Database;

beforeEach(() => {
  db = createTestDb();
  raw = (db as unknown as { db: Database.Database }).db;
  insertTestProject(raw);
});

// ── claimIdempotencyKey ──────────────────────────────────────────────────────

describe('claimIdempotencyKey — expired key reuse', () => {
  it('allows reuse of an expired idempotency key', async () => {
    // Insert an already-expired row for the same (key, scope).
    // Use strftime ISO format so expires_at compares correctly against isoNow() strings.
    raw
      .prepare(
        `INSERT INTO idempotency_keys (id, key, scope, result, expires_at, version, created_at, updated_at)
         VALUES ('old-id', 'k1', 'test-scope', NULL,
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 second'), 1,
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-10 seconds'),
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-10 seconds'))`,
      )
      .run();

    const claim = await db.transaction(async (tx) =>
      claimIdempotencyKey(tx, 'k1', 'test-scope', 60_000),
    );
    expect(claim.owned).toBe(true);

    // Old expired row must be gone
    const old = raw.prepare(`SELECT id FROM idempotency_keys WHERE id = 'old-id'`).get();
    expect(old).toBeUndefined();
  });

  it('returns cached result when the same key is replayed after fulfillment', async () => {
    // First execution
    let claimId: string | undefined;
    await db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey(tx, 'k2', 'test-scope', 60_000);
      expect(claim.owned).toBe(true);
      if (claim.owned) {
        claimId = claim.claimId;
        await fulfillIdempotencyKey(tx, claim.claimId, {
          commandId: 'cmd-1',
          accepted: true,
          resultingState: 'selected',
          emittedEventIds: ['evt-1'],
        });
      }
    });
    expect(claimId).toBeDefined();

    // Replay — should return cached result without owning the slot
    const replay = await db.transaction(async (tx) =>
      claimIdempotencyKey(tx, 'k2', 'test-scope', 60_000),
    );
    expect(replay.owned).toBe(false);
    if (!replay.owned) {
      expect(replay.result.resultingState).toBe('selected');
    }
  });

  it('throws 409 when a concurrent in-progress row exists (NULL result)', async () => {
    // Simulate an in-progress row (result = NULL, not expired).
    // Must use ISO format so the expires_at > now check in claimIdempotencyKey works correctly.
    raw
      .prepare(
        `INSERT INTO idempotency_keys (id, key, scope, result, expires_at, version, created_at, updated_at)
         VALUES ('in-progress-id', 'k3', 'test-scope', NULL,
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+3600 seconds'), 1,
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      )
      .run();

    await expect(
      db.transaction(async (tx) => claimIdempotencyKey(tx, 'k3', 'test-scope', 60_000)),
    ).rejects.toThrow('concurrent');
  });
});

// ── assertLockFence ──────────────────────────────────────────────────────────

describe('assertLockFence — lock boundary validation', () => {
  function insertLock(opts: {
    id: string;
    projectId: string;
    resourceKey: string;
    holderId: string;
    fence: number;
    expiresOffsetSeconds?: number;
  }): void {
    const offset = opts.expiresOffsetSeconds ?? 3600;
    // Use ISO format so expires_at compares correctly against isoNow() strings in assertLockFence
    const expiresAt = new Date(Date.now() + offset * 1000).toISOString();
    const now = new Date().toISOString();
    raw
      .prepare(
        `INSERT INTO workflow_locks (id, project_id, resource_key, holder_id, fence, expires_at, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        opts.id,
        opts.projectId,
        opts.resourceKey,
        opts.holderId,
        opts.fence,
        expiresAt,
        now,
        now,
      );
  }

  it('succeeds when projectId and resourceKey match', async () => {
    insertLock({
      id: 'lock-1',
      projectId: 'proj-1',
      resourceKey: 'execution-lane:proj-1',
      holderId: 'holder-1',
      fence: 1,
    });

    await expect(
      db.transaction(async (tx) =>
        assertLockFence(tx, {
          lockId: 'lock-1',
          fence: 1,
          holderId: 'holder-1',
          projectId: 'proj-1',
          resourceKey: 'execution-lane:proj-1',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('throws StaleFenceError when projectId does not match', async () => {
    insertLock({
      id: 'lock-2',
      projectId: 'proj-1',
      resourceKey: 'execution-lane:proj-1',
      holderId: 'holder-1',
      fence: 1,
    });

    await expect(
      db.transaction(async (tx) =>
        assertLockFence(tx, {
          lockId: 'lock-2',
          fence: 1,
          holderId: 'holder-1',
          projectId: 'proj-WRONG',
          resourceKey: 'execution-lane:proj-1',
        }),
      ),
    ).rejects.toBeInstanceOf(StaleFenceError);
  });

  it('throws StaleFenceError when resourceKey does not match', async () => {
    insertLock({
      id: 'lock-3',
      projectId: 'proj-1',
      resourceKey: 'execution-lane:proj-1',
      holderId: 'holder-1',
      fence: 1,
    });

    await expect(
      db.transaction(async (tx) =>
        assertLockFence(tx, {
          lockId: 'lock-3',
          fence: 1,
          holderId: 'holder-1',
          projectId: 'proj-1',
          resourceKey: 'execution-lane:WRONG',
        }),
      ),
    ).rejects.toBeInstanceOf(StaleFenceError);
  });

  it('throws StaleFenceError when lock has expired', async () => {
    insertLock({
      id: 'lock-4',
      projectId: 'proj-1',
      resourceKey: 'execution-lane:proj-1',
      holderId: 'holder-1',
      fence: 1,
      expiresOffsetSeconds: -1,
    });

    await expect(
      db.transaction(async (tx) =>
        assertLockFence(tx, {
          lockId: 'lock-4',
          fence: 1,
          holderId: 'holder-1',
          projectId: 'proj-1',
          resourceKey: 'execution-lane:proj-1',
        }),
      ),
    ).rejects.toBeInstanceOf(StaleFenceError);
  });

  it('throws StaleFenceError when fence value is stale', async () => {
    insertLock({
      id: 'lock-5',
      projectId: 'proj-1',
      resourceKey: 'execution-lane:proj-1',
      holderId: 'holder-1',
      fence: 3,
    });

    await expect(
      db.transaction(async (tx) =>
        assertLockFence(tx, {
          lockId: 'lock-5',
          fence: 1,
          holderId: 'holder-1',
          projectId: 'proj-1',
          resourceKey: 'execution-lane:proj-1',
        }),
      ),
    ).rejects.toBeInstanceOf(StaleFenceError);
  });
});
