import { StaleFenceError } from '@minicoder/core';
import type { DbClient, TxClient } from '@minicoder/core';
import type { AcquiredLock, LockOptions } from './types.js';
import { LockConflictError } from './types.js';

function isoNow(): string {
  return new Date().toISOString();
}

function isoExpiry(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString();
}

function generateId(): string {
  return `lock-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface LockRow {
  id: string;
  fence: number;
  expires_at: string;
}

export class WorkflowLockManager {
  constructor(private readonly db: DbClient) {}

  async acquire(
    projectId: string,
    resourceKey: string,
    options: LockOptions,
  ): Promise<AcquiredLock> {
    const now = isoNow();
    const expiresAt = isoExpiry(options.ttlMs);
    const lockId = generateId();

    return this.db.transaction(async (tx) => {
      // Atomic UPDATE: claim if lock is expired or we already hold it.
      // fence = fence + 1 ensures every acquire produces a unique monotonic token.
      const updated = await tx.executeAffected(
        `UPDATE workflow_locks
         SET holder_id = ?, fence = fence + 1, expires_at = ?, version = version + 1, updated_at = ?
         WHERE project_id = ? AND resource_key = ?
           AND (expires_at <= ? OR holder_id = ?)`,
        [options.holderId, expiresAt, now, projectId, resourceKey, now, options.holderId],
      );

      if (updated === 0) {
        // No existing row to claim — try INSERT for a brand-new lock.
        const inserted = await tx.executeAffected(
          `INSERT INTO workflow_locks
             (id, project_id, resource_key, holder_id, fence, expires_at, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?)
           ON CONFLICT (project_id, resource_key) DO NOTHING`,
          [lockId, projectId, resourceKey, options.holderId, expiresAt, now, now],
        );

        if (inserted === 0) {
          // Row exists and is not expired/same-holder — another holder owns the lock.
          throw new LockConflictError(resourceKey, options.holderId);
        }
      }

      // Read back the current fence (set atomically by UPDATE or 1 for fresh INSERT).
      const rows = await tx.query<LockRow>(
        `SELECT id, fence, expires_at
         FROM workflow_locks
         WHERE project_id = ? AND resource_key = ?`,
        [projectId, resourceKey],
      );
      const lock = rows[0];
      if (!lock) throw new Error(`Lock row missing after acquire for ${projectId}/${resourceKey}`);

      return {
        lockId: lock.id,
        resourceKey,
        fence: lock.fence,
        expiresAt: lock.expires_at,
        holderId: options.holderId,
      };
    });
  }

  async release(lock: AcquiredLock): Promise<void> {
    await this.db.execute(
      `DELETE FROM workflow_locks
       WHERE id = ? AND holder_id = ? AND fence = ?`,
      [lock.lockId, lock.holderId, lock.fence],
    );
  }

  async heartbeat(lock: AcquiredLock, ttlMs: number): Promise<void> {
    const now = isoNow();
    const newExpiry = isoExpiry(ttlMs);
    await this.db.execute(
      `UPDATE workflow_locks
       SET expires_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND holder_id = ? AND fence = ?`,
      [newExpiry, now, lock.lockId, lock.holderId, lock.fence],
    );
  }

  async assertFence(lock: AcquiredLock, tx: TxClient): Promise<void> {
    const now = isoNow();
    const rows = await tx.query<{ fence: number; expires_at: string | Date | null }>(
      `SELECT fence, expires_at FROM workflow_locks WHERE id = ?`,
      [lock.lockId],
    );
    const current = rows[0];
    const expiresAtStr = current?.expires_at instanceof Date
      ? current.expires_at.toISOString()
      : (current?.expires_at ?? null);
    if (!current || (expiresAtStr !== null && expiresAtStr < now)) {
      throw new StaleFenceError(lock.lockId, lock.fence, current?.fence ?? -1);
    }
    if (current.fence !== lock.fence) {
      throw new StaleFenceError(lock.lockId, lock.fence, current.fence);
    }
  }
}
