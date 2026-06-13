export interface AcquiredLock {
  readonly lockId: string;
  readonly resourceKey: string;
  readonly fence: number;
  readonly expiresAt: string;
  readonly holderId: string;
}

export interface LockOptions {
  readonly ttlMs: number;
  readonly holderId: string;
}

export class LockConflictError extends Error {
  constructor(
    public readonly resourceKey: string,
    public readonly currentHolder: string,
  ) {
    super(`Lock conflict on '${resourceKey}': held by '${currentHolder}'`);
    this.name = 'LockConflictError';
  }
}
