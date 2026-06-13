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
  resource_key: string;
  holder_id: string;
  fence: number;
  expires_at: string;
  version: number;
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

    return this.db.transaction(async (tx) => {
      const rows = await tx.query<LockRow>(
        `SELECT id, resource_key, holder_id, fence, expires_at, version
         FROM workflow_locks
         WHERE project_id = ? AND resource_key = ?`,
        [projectId, resourceKey],
      );

      const existing = rows[0];

      if (existing) {
        const isExpired = existing.expires_at <= now;
        const isSameHolder = existing.holder_id === options.holderId;

        if (!isExpired && !isSameHolder) {
          throw new LockConflictError(resourceKey, existing.holder_id);
        }

        const newFence = existing.fence + 1;
        await tx.execute(
          `UPDATE workflow_locks
           SET holder_id = ?, fence = ?, expires_at = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
          [options.holderId, newFence, expiresAt, now, existing.id],
        );

        return {
          lockId: existing.id,
          resourceKey,
          fence: newFence,
          expiresAt,
          holderId: options.holderId,
        };
      }

      const lockId = generateId();
      await tx.execute(
        `INSERT INTO workflow_locks (id, project_id, resource_key, holder_id, fence, expires_at, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?)`,
        [lockId, projectId, resourceKey, options.holderId, expiresAt, now, now],
      );

      return {
        lockId,
        resourceKey,
        fence: 1,
        expiresAt,
        holderId: options.holderId,
      };
    });
  }

  async release(lock: AcquiredLock): Promise<void> {
    const now = isoNow();
    await this.db.execute(
      `DELETE FROM workflow_locks
       WHERE id = ? AND holder_id = ? AND fence = ?`,
      [lock.lockId, lock.holderId, lock.fence],
    );
    void now;
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
    const rows = await tx.query<{ fence: number }>(
      `SELECT fence FROM workflow_locks WHERE id = ?`,
      [lock.lockId],
    );
    const current = rows[0];
    if (!current || current.fence !== lock.fence) {
      throw new StaleFenceError(lock.lockId, lock.fence, current?.fence ?? -1);
    }
  }
}
