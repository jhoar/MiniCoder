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
    const [id, lastEventId, updatedAt] = params as [string, string, string];
    this.rows.set(id, { id, last_event_id: lastEventId, updated_at: updatedAt });
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
    await setObservabilityExportCursor(db, 'workflow_events_otlp', 'evt-42');
    expect(await getObservabilityExportCursor(db, 'workflow_events_otlp')).toBe('evt-42');
  });

  it('overwrites a prior cursor on a later call (upsert, not insert-only)', async () => {
    const db = new FakeCursorDb();
    await setObservabilityExportCursor(db, 'workflow_events_otlp', 'evt-1');
    await setObservabilityExportCursor(db, 'workflow_events_otlp', 'evt-2');
    expect(await getObservabilityExportCursor(db, 'workflow_events_otlp')).toBe('evt-2');
  });

  it('keeps distinct cursor ids independent', async () => {
    const db = new FakeCursorDb();
    await setObservabilityExportCursor(db, 'target-a', 'evt-a');
    await setObservabilityExportCursor(db, 'target-b', 'evt-b');
    expect(await getObservabilityExportCursor(db, 'target-a')).toBe('evt-a');
    expect(await getObservabilityExportCursor(db, 'target-b')).toBe('evt-b');
  });
});
