import { WorkflowLockManager } from '../locks/manager.js';
import type { AcquiredLock, LockOptions } from '../locks/types.js';
import { LockConflictError } from '../locks/types.js';
import type { DbClient } from '@minicoder/core';

function executionLaneKey(projectId: string): string {
  return `execution-lane:${projectId}`;
}

export class ExecutionLane {
  private readonly lockManager: WorkflowLockManager;

  constructor(private readonly db: DbClient) {
    this.lockManager = new WorkflowLockManager(db);
  }

  /**
   * Acquires the project-scoped execution lane lock.
   * Throws LockConflictError if another active feature run holds the lane.
   * Sequential execution is enforced here — not in the database schema.
   */
  async acquireForProject(
    projectId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<AcquiredLock> {
    const options: LockOptions = { holderId, ttlMs };
    return this.lockManager.acquire(projectId, executionLaneKey(projectId), options);
  }

  async releaseForProject(lock: AcquiredLock): Promise<void> {
    await this.lockManager.release(lock);
  }
}

export { LockConflictError };
