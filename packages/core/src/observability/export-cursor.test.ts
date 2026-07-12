import { describe, it, expect } from 'vitest';
import type { DbClient, TxClient } from '../persistence/types.js';
import {
  getObservabilityExportCursor,
  setObservabilityExportCursor,
  type ObservabilityExportCursorRow,
} from './export-cursor.js';

/** In-memory stand-in for `observability_export_cursors`, keyed by `id` — exercises the same
 * `SELECT`/`INSERT ... ON CONFLICT DO UPDATE` shape the real SQLite/PostgreSQL tables both
 * accept, without depending on a concrete migrated DB (core has no persistence-package
 * dependency — see `otel-export.test.ts`'s identical `FakeDb` convention). */
class FakeCursorDb implements DbClient {
  private readonly rows = new Map<string, ObservabilityExportCursorRow>();

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const id = params[0] as string;
    const row = this.rows.get(id);
    return (row ? [row] : []) as unknown as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    const [id, lastEventId, lastOccurredAt, updatedAt] = params as [string, string, string, string];
    this.rows.set(id, {
      id,
      last_event_id: lastEventId,
      last_occurred_at: lastOccurredAt,
      updated_at: updatedAt,
    });
  }

  async executeAffected(): Promise<number> {
    return 0;
  }

  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}

describe('observability export cursor', () => {
  it('returns null when no cursor row exists yet', async () => {
    const db = new FakeCursorDb();
    expect(await getObservabilityExportCursor(db, 'workflow_events_otlp')).toBeNull();
  });

  it('round-trips a stored cursor', async () => {
    const db = new FakeCursorDb();
    await setObservabilityExportCursor(db, 'workflow_events_otlp', {
      lastEventId: 'evt-42',
      lastOccurredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await getObservabilityExportCursor(db, 'workflow_events_otlp')).toEqual({
      lastEventId: 'evt-42',
      lastOccurredAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('overwrites a prior cursor on a later call (upsert, not insert-only)', async () => {
    const db = new FakeCursorDb();
    await setObservabilityExportCursor(db, 'workflow_events_otlp', {
      lastEventId: 'evt-1',
      lastOccurredAt: '2026-01-01T00:00:00.000Z',
    });
    await setObservabilityExportCursor(db, 'workflow_events_otlp', {
      lastEventId: 'evt-2',
      lastOccurredAt: '2026-01-01T00:01:00.000Z',
    });
    expect(await getObservabilityExportCursor(db, 'workflow_events_otlp')).toEqual({
      lastEventId: 'evt-2',
      lastOccurredAt: '2026-01-01T00:01:00.000Z',
    });
  });

  it('keeps distinct cursor ids independent', async () => {
    const db = new FakeCursorDb();
    await setObservabilityExportCursor(db, 'target-a', {
      lastEventId: 'evt-a',
      lastOccurredAt: '2026-01-01T00:00:00.000Z',
    });
    await setObservabilityExportCursor(db, 'target-b', {
      lastEventId: 'evt-b',
      lastOccurredAt: '2026-01-01T00:01:00.000Z',
    });
    expect((await getObservabilityExportCursor(db, 'target-a'))?.lastEventId).toBe('evt-a');
    expect((await getObservabilityExportCursor(db, 'target-b'))?.lastEventId).toBe('evt-b');
  });
});
