import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import type { DbClient } from '@minicoder/core';
import { runDoctorChecks, listWorkflowLocks } from './diagnostics.js';

async function seedProject(db: DbClient, projectId: string): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', 'active', 1, datetime('now'), datetime('now'))`,
    [projectId],
  );
}

/** Mirrors `WorkflowLockManager.acquire()`: `expires_at` is set independently of `updated_at`,
 * roughly `ttlMs` later. */
async function seedOrphanedLock(db: DbClient, projectId: string, id: string): Promise<void> {
  const acquiredAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const expiresAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await db.execute(
    `INSERT INTO workflow_locks (id, project_id, resource_key, holder_id, fence, acquired_at, expires_at, version, created_at, updated_at)
     VALUES (?, ?, ?, 'holder-1', 1, ?, ?, 1, ?, ?)`,
    [id, projectId, `execution-lane:${id}`, acquiredAt, expiresAt, acquiredAt, acquiredAt],
  );
}

/** Mirrors `WorkflowLockManager.release()`: `expires_at` and `updated_at` are set to the exact
 * same `now` value. */
async function seedCleanlyReleasedLock(db: DbClient, projectId: string, id: string): Promise<void> {
  const acquiredAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const releasedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await db.execute(
    `INSERT INTO workflow_locks (id, project_id, resource_key, holder_id, fence, acquired_at, expires_at, version, created_at, updated_at)
     VALUES (?, ?, ?, 'holder-1', 2, ?, ?, 1, ?, ?)`,
    [id, projectId, `execution-lane:${id}`, acquiredAt, releasedAt, acquiredAt, releasedAt],
  );
}

describe('runDoctorChecks stale_locks (issue #109)', () => {
  it('does not flag a stale-but-cleanly-released lock as an error', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-locks-clean';
    await seedProject(db, projectId);
    await seedCleanlyReleasedLock(db, projectId, 'lock-clean-1');

    const result = await runDoctorChecks(db, projectId);
    const staleLocksCheck = result.checks.find((c) => c.name === 'stale_locks')!;
    expect(staleLocksCheck.severity).toBe('ok');
    expect(staleLocksCheck.count).toBe(0);
  });

  it('flags a genuinely orphaned (expired, never released) lock as an error', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-locks-orphaned';
    await seedProject(db, projectId);
    await seedOrphanedLock(db, projectId, 'lock-orphaned-1');

    const result = await runDoctorChecks(db, projectId);
    const staleLocksCheck = result.checks.find((c) => c.name === 'stale_locks')!;
    expect(staleLocksCheck.severity).toBe('error');
    expect(staleLocksCheck.count).toBe(1);
    expect(result.healthy).toBe(false);
  });

  it('reports ok when a project has both an orphaned lock and a cleanly-released one — only the orphaned one counts', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-locks-mixed';
    await seedProject(db, projectId);
    await seedCleanlyReleasedLock(db, projectId, 'lock-mixed-clean');
    await seedOrphanedLock(db, projectId, 'lock-mixed-orphaned');

    const result = await runDoctorChecks(db, projectId);
    const staleLocksCheck = result.checks.find((c) => c.name === 'stale_locks')!;
    expect(staleLocksCheck.count).toBe(1);
    expect((staleLocksCheck.details as { id: string }[])[0]?.id).toBe('lock-mixed-orphaned');
  });
});

describe('listWorkflowLocks (issue #109)', () => {
  it('lists resource_key/holder_id/fence/acquired_at detail and computes stale/releasedCleanly', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-locks-list';
    await seedProject(db, projectId);
    await seedCleanlyReleasedLock(db, projectId, 'lock-list-clean');
    await seedOrphanedLock(db, projectId, 'lock-list-orphaned');

    const locks = await listWorkflowLocks(db, { projectId, staleOnly: false });
    expect(locks).toHaveLength(2);

    const clean = locks.find((l) => l.id === 'lock-list-clean')!;
    expect(clean.resource_key).toBe('execution-lane:lock-list-clean');
    expect(clean.holder_id).toBe('holder-1');
    expect(clean.fence).toBe(2);
    expect(clean.stale).toBe(true);
    expect(clean.releasedCleanly).toBe(true);

    const orphaned = locks.find((l) => l.id === 'lock-list-orphaned')!;
    expect(orphaned.stale).toBe(true);
    expect(orphaned.releasedCleanly).toBe(false);
  });

  it('staleOnly: true (the default) excludes a still-live lock', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-locks-live';
    await seedProject(db, projectId);
    const acquiredAt = new Date().toISOString();
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await db.execute(
      `INSERT INTO workflow_locks (id, project_id, resource_key, holder_id, fence, acquired_at, expires_at, version, created_at, updated_at)
       VALUES ('lock-live-1', ?, 'execution-lane:test', 'holder-1', 1, ?, ?, 1, ?, ?)`,
      [projectId, acquiredAt, futureExpiry, acquiredAt, acquiredAt],
    );
    await seedOrphanedLock(db, projectId, 'lock-live-orphaned');

    const staleOnly = await listWorkflowLocks(db, { projectId, staleOnly: true });
    expect(staleOnly.map((l) => l.id)).toEqual(['lock-live-orphaned']);

    const all = await listWorkflowLocks(db, { projectId, staleOnly: false });
    expect(all).toHaveLength(2);
  });
});
