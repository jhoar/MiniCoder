import type { DbClient } from '@minicoder/core';
import { deterministicBackoff } from './backoff.js';

export interface OutboxHandler {
  readonly eventType: string;
  handle(payload: unknown, schemaVersion: string): Promise<void>;
}

export interface DispatcherOptions {
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

const DEFAULT_OPTIONS: DispatcherOptions = {
  batchSize: 10,
  maxAttempts: 5,
  baseBackoffMs: 1000,
  maxBackoffMs: 60_000,
};

interface OutboxRow {
  id: string;
  event_type: string;
  payload: string;
  payload_schema_version: string;
  attempts: number;
  version: number;
}

function isoNow(): string {
  return new Date().toISOString();
}

export class OutboxDispatcher {
  private readonly options: DispatcherOptions;

  constructor(
    private readonly db: DbClient,
    private readonly handlers: Map<string, OutboxHandler>,
    options: Partial<DispatcherOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async pollAndDispatch(): Promise<{ dispatched: number; failed: number }> {
    const now = isoNow();
    const rows = await this.db.query<OutboxRow>(
      `SELECT id, event_type, payload, payload_schema_version, attempts, version
       FROM outbox_events
       WHERE status IN ('pending', 'failed')
         AND attempts < ?
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`,
      [this.options.maxAttempts, now, this.options.batchSize],
    );

    let dispatched = 0;
    let failed = 0;

    for (const row of rows) {
      // Atomic claim: only proceed if we successfully mark as 'processing'.
      // If another worker already claimed this row, skip it in this poll cycle.
      const claimed = await this.db.executeAffected(
        `UPDATE outbox_events SET status = 'processing', version = version + 1, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'failed')`,
        [isoNow(), row.id],
      );
      if (claimed === 0) continue;

      const handler = this.handlers.get(row.event_type);
      if (!handler) {
        // No handler registered yet — requeue as pending so it retries when a
        // handler is registered, rather than permanently skipping it.
        await this.db.execute(
          `UPDATE outbox_events SET status = 'pending', version = version + 1, updated_at = ? WHERE id = ?`,
          [isoNow(), row.id],
        );
        continue;
      }

      try {
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload) as unknown;
        } catch {
          throw new Error(`Invalid JSON payload for outbox event ${row.id}`);
        }
        await handler.handle(payload, row.payload_schema_version);
        await this.markDelivered(row.id);
        dispatched++;
      } catch {
        const nextAttempts = row.attempts + 1;
        const nextRetryMs = deterministicBackoff(
          nextAttempts,
          this.options.baseBackoffMs,
          this.options.maxBackoffMs,
        );
        const nextRetryAt = new Date(Date.now() + nextRetryMs).toISOString();
        await this.markFailed(row.id, nextAttempts, nextRetryAt);
        failed++;
      }
    }

    return { dispatched, failed };
  }

  private async markDelivered(id: string): Promise<void> {
    await this.db.execute(
      `UPDATE outbox_events SET status = 'delivered', version = version + 1, updated_at = ? WHERE id = ?`,
      [isoNow(), id],
    );
  }

  private async markFailed(id: string, attempts: number, nextRetryAt: string): Promise<void> {
    await this.db.execute(
      `UPDATE outbox_events SET status = 'failed', attempts = ?, next_retry_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      [attempts, nextRetryAt, isoNow(), id],
    );
  }
}
