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
    const now = isoNow();
    const before = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM idempotency_keys WHERE expires_at <= ?`,
      [now],
    );
    await this.db.execute(`DELETE FROM idempotency_keys WHERE expires_at <= ?`, [now]);
    return { removed: before[0]?.count ?? 0 };
  }
}
