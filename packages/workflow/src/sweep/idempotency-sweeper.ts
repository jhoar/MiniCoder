import type { DbClient } from '@minicoder/core';

function isoNow(): string {
  return new Date().toISOString();
}

export class IdempotencySweeper {
  constructor(private readonly db: DbClient) {}

  /**
   * Removes expired idempotency key rows. Safe to call concurrently;
   * each call only deletes rows where expires_at <= now.
   */
  async sweep(): Promise<{ removed: number }> {
    const removed = await this.db.executeAffected(
      `DELETE FROM idempotency_keys WHERE expires_at <= ?`,
      [isoNow()],
    );
    return { removed };
  }
}
