import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteDbClient } from '@minicoder/persistence-sqlite';
import { StaleFenceError } from '@minicoder/core';
import { WorkflowLockManager } from './manager.js';
import { LockConflictError } from './types.js';
import { createTestDb, insertTestProject } from '../test-helpers.js';

let db: SqliteDbClient;
let raw: Database.Database;
let manager: WorkflowLockManager;

beforeEach(() => {
  db = createTestDb();
  raw = (db as unknown as { db: Database.Database }).db;
  insertTestProject(raw);
  manager = new WorkflowLockManager(db);
});

const PROJECT = 'proj-1';
const RESOURCE = 'test-resource';

describe('WorkflowLockManager.acquire', () => {
  it('acquires a new lock with fence=1', async () => {
    const lock = await manager.acquire(PROJECT, RESOURCE, { holderId: 'h1', ttlMs: 60_000 });
    expect(lock.fence).toBe(1);
    expect(lock.holderId).toBe('h1');
    expect(lock.resourceKey).toBe(RESOURCE);
  });

  it('re-acquiring by same holder increments fence', async () => {
    const lock1 = await manager.acquire(PROJECT, RESOURCE, { holderId: 'h1', ttlMs: 60_000 });
    const lock2 = await manager.acquire(PROJECT, RESOURCE, { holderId: 'h1', ttlMs: 60_000 });
    expect(lock2.fence).toBe(lock1.fence + 1);
  });

  it('throws LockConflictError when held by a different holder', async () => {
    await manager.acquire(PROJECT, RESOURCE, { holderId: 'h1', ttlMs: 60_000 });
    await expect(
      manager.acquire(PROJECT, RESOURCE, { holderId: 'h2', ttlMs: 60_000 }),
    ).rejects.toThrow(LockConflictError);
  });

  it('allows re-acquisition by new holder after expiry', async () => {
    // Insert an expired lock directly
    raw
      .prepare(
        `INSERT INTO workflow_locks (id, project_id, resource_key, holder_id, fence, expires_at, version, created_at, updated_at)
       VALUES ('lock-old', ?, ?, 'h1', 5, datetime('now', '-1 second'), 1, datetime('now'), datetime('now'))`,
      )
      .run(PROJECT, RESOURCE);

    const lock = await manager.acquire(PROJECT, RESOURCE, { holderId: 'h2', ttlMs: 60_000 });
    expect(lock.fence).toBe(6);
    expect(lock.holderId).toBe('h2');
  });
});

describe('WorkflowLockManager.assertFence', () => {
  it('passes when fence matches', async () => {
    const lock = await manager.acquire(PROJECT, RESOURCE, { holderId: 'h1', ttlMs: 60_000 });
    await expect(db.transaction((tx) => manager.assertFence(lock, tx))).resolves.not.toThrow();
  });

  it('throws StaleFenceError when fence has advanced', async () => {
    const lock = await manager.acquire(PROJECT, RESOURCE, { holderId: 'h1', ttlMs: 60_000 });
    // Simulate another acquisition advancing the fence
    raw.prepare(`UPDATE workflow_locks SET fence = fence + 1 WHERE id = ?`).run(lock.lockId);

    await expect(db.transaction((tx) => manager.assertFence(lock, tx))).rejects.toThrow(
      StaleFenceError,
    );
  });
});

describe('WorkflowLockManager.release', () => {
  it('expires the lock row and increments fence so the next acquire gets a higher fence', async () => {
    const lock = await manager.acquire(PROJECT, RESOURCE, { holderId: 'h1', ttlMs: 60_000 });
    await manager.release(lock);

    // Row must still exist (not deleted) so the fence counter survives
    const rows = raw
      .prepare('SELECT fence, expires_at FROM workflow_locks WHERE id = ?')
      .all(lock.lockId) as Array<{ fence: number; expires_at: string }>;
    expect(rows).toHaveLength(1);
    const lockRow = rows[0]!; // length asserted above
    expect(lockRow.fence).toBe(lock.fence + 1); // fence incremented on release

    // Re-acquire must return a fence strictly greater than the released fence
    const lock2 = await manager.acquire(PROJECT, RESOURCE, { holderId: 'h2', ttlMs: 60_000 });
    expect(lock2.fence).toBeGreaterThan(lock.fence);
  });

  it('is a no-op if fence does not match (stale release)', async () => {
    const lock = await manager.acquire(PROJECT, RESOURCE, { holderId: 'h1', ttlMs: 60_000 });
    const staleLock = { ...lock, fence: lock.fence + 99 };
    await expect(manager.release(staleLock)).resolves.not.toThrow();
    // Lock should still exist
    const rows = raw.prepare('SELECT * FROM workflow_locks WHERE id = ?').all(lock.lockId);
    expect(rows).toHaveLength(1);
  });
});
