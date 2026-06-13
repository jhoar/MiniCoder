import type { DbClient } from '@minicoder/core';
import { parseJsonField } from '@minicoder/core';
import { deterministicBackoff } from '../outbox/backoff.js';

export interface InboxHandler {
  readonly eventType: string;
  handle(payload: unknown, schemaVersion: string): Promise<void>;
}

export interface ProcessorOptions {
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly staleClaimMs: number;
}

const DEFAULT_OPTIONS: ProcessorOptions = {
  batchSize: 10,
  maxAttempts: 5,
  baseBackoffMs: 1000,
  maxBackoffMs: 60_000,
  staleClaimMs: 300_000,
};

interface InboxRow {
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

export class InboxProcessor {
  private readonly options: ProcessorOptions;

  constructor(
    private readonly db: DbClient,
    private readonly handlers: Map<string, InboxHandler>,
    options: Partial<ProcessorOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async pollAndProcess(): Promise<{ processed: number; failed: number }> {
    // Stale claim recovery: reset any rows stuck in 'processing' for too long
    const staleThreshold = new Date(Date.now() - this.options.staleClaimMs).toISOString();
    await this.db.execute(
      `UPDATE inbox_events SET status = 'pending', version = version + 1, updated_at = ?
       WHERE status = 'processing' AND updated_at <= ?`,
      [isoNow(), staleThreshold],
    );

    const now = isoNow();
    const rows = await this.db.query<InboxRow>(
      `SELECT id, event_type, payload, payload_schema_version, attempts, version
       FROM inbox_events
       WHERE status IN ('pending', 'failed')
         AND attempts < ?
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`,
      [this.options.maxAttempts, now, this.options.batchSize],
    );

    let processed = 0;
    let failed = 0;

    for (const row of rows) {
      // Atomic claim: include version = ? so claimedVersion = row.version + 1 is always accurate.
      const claimed = await this.db.executeAffected(
        `UPDATE inbox_events SET status = 'processing', version = version + 1, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'failed') AND version = ?`,
        [isoNow(), row.id, row.version],
      );
      if (claimed === 0) continue;

      const claimedVersion = row.version + 1;

      const handler = this.handlers.get(row.event_type);
      if (!handler) {
        // No handler registered yet — requeue as pending so it retries when a
        // handler is registered, rather than permanently skipping it.
        await this.db.execute(
          `UPDATE inbox_events SET status = 'pending', version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
          [isoNow(), row.id, claimedVersion],
        );
        continue;
      }

      try {
        const payload = parseJsonField<unknown>(row.payload);
        await handler.handle(payload, row.payload_schema_version);
        await this.markProcessed(row.id, claimedVersion);
        processed++;
      } catch {
        const nextAttempts = row.attempts + 1;
        const nextRetryMs = deterministicBackoff(
          nextAttempts,
          this.options.baseBackoffMs,
          this.options.maxBackoffMs,
        );
        const nextRetryAt = new Date(Date.now() + nextRetryMs).toISOString();
        await this.markFailed(row.id, nextAttempts, nextRetryAt, claimedVersion);
        failed++;
      }
    }

    return { processed, failed };
  }

  private async markProcessed(id: string, claimedVersion: number): Promise<void> {
    await this.db.execute(
      `UPDATE inbox_events SET status = 'processed', version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      [isoNow(), id, claimedVersion],
    );
  }

  private async markFailed(id: string, attempts: number, nextRetryAt: string, claimedVersion: number): Promise<void> {
    await this.db.execute(
      `UPDATE inbox_events SET status = 'failed', attempts = ?, next_retry_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      [attempts, nextRetryAt, isoNow(), id, claimedVersion],
    );
  }
}
