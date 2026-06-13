import type { DbClient } from '@minicoder/core';
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
}

const DEFAULT_OPTIONS: ProcessorOptions = {
  batchSize: 10,
  maxAttempts: 5,
  baseBackoffMs: 1000,
  maxBackoffMs: 60_000,
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
      const handler = this.handlers.get(row.event_type);
      if (!handler) {
        await this.markSkipped(row.id);
        continue;
      }

      try {
        const payload = JSON.parse(row.payload) as unknown;
        await handler.handle(payload, row.payload_schema_version);
        await this.markProcessed(row.id);
        processed++;
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

    return { processed, failed };
  }

  private async markProcessed(id: string): Promise<void> {
    await this.db.execute(
      `UPDATE inbox_events SET status = 'processed', version = version + 1, updated_at = ? WHERE id = ?`,
      [isoNow(), id],
    );
  }

  private async markFailed(id: string, attempts: number, nextRetryAt: string): Promise<void> {
    await this.db.execute(
      `UPDATE inbox_events SET status = 'failed', attempts = ?, next_retry_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      [attempts, nextRetryAt, isoNow(), id],
    );
  }

  private async markSkipped(id: string): Promise<void> {
    await this.db.execute(
      `UPDATE inbox_events SET status = 'skipped', version = version + 1, updated_at = ? WHERE id = ?`,
      [isoNow(), id],
    );
  }
}
