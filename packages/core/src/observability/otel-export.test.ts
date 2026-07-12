import { describe, it, expect, vi } from 'vitest';
import type { DbClient, TxClient } from '../persistence/types.js';
import type { ConfigBackend } from '../config/config.js';
import {
  mapWorkflowEventsToOtlp,
  exportWorkflowEventsToOtlp,
  type WorkflowEventRow,
} from './otel-export.js';

function event(overrides: Partial<WorkflowEventRow> = {}): WorkflowEventRow {
  return {
    id: 'evt-1',
    feature_run_id: 'run-1',
    project_id: 'proj-1',
    event_type: 'feature.selected',
    from_state: 'approved_pending_execution',
    to_state: 'selected',
    actor: 'system',
    occurred_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('mapWorkflowEventsToOtlp', () => {
  it('maps an empty event list to a shape with zero log records', () => {
    const payload = mapWorkflowEventsToOtlp([]);
    expect(payload.resourceLogs[0]!.scopeLogs[0]!.logRecords).toEqual([]);
  });

  it('maps one event to one OTLP log record with the expected attributes', () => {
    const payload = mapWorkflowEventsToOtlp([event()]);
    const record = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
    expect(record.body.stringValue).toBe('feature.selected');
    expect(record.severityText).toBe('INFO');
    const attrMap = Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue]));
    expect(attrMap['minicoder.event_id']).toBe('evt-1');
    expect(attrMap['minicoder.project_id']).toBe('proj-1');
    expect(attrMap['minicoder.from_state']).toBe('approved_pending_execution');
    expect(attrMap['minicoder.to_state']).toBe('selected');
  });

  it('never throws on a malformed occurred_at timestamp', () => {
    expect(() => mapWorkflowEventsToOtlp([event({ occurred_at: 'not-a-date' })])).not.toThrow();
  });
});

class FakeConfig implements ConfigBackend {
  constructor(private readonly values: Record<string, string | undefined>) {}
  get(key: string): string | undefined {
    return this.values[key];
  }
  getRequired(key: string): string {
    const value = this.values[key];
    if (value === undefined) throw new Error(`missing required config key: ${key}`);
    return value;
  }
}

class FakeDb implements DbClient {
  constructor(private readonly rows: WorkflowEventRow[]) {}
  async query<T = Record<string, unknown>>(): Promise<T[]> {
    return this.rows as unknown as T[];
  }
  async execute(): Promise<void> {}
  async executeAffected(): Promise<number> {
    return 0;
  }
  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async close(): Promise<void> {}
}

describe('exportWorkflowEventsToOtlp', () => {
  it('is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is not configured', async () => {
    const db = new FakeDb([event()]);
    const fetchImpl = vi.fn();
    const result = await exportWorkflowEventsToOtlp(db, {
      config: new FakeConfig({}),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ attempted: false, exportedCount: 0, lastEventId: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a no-op when the endpoint is configured but blank', async () => {
    const db = new FakeDb([event()]);
    const fetchImpl = vi.fn();
    const result = await exportWorkflowEventsToOtlp(db, {
      config: new FakeConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.attempted).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs the mapped payload to <endpoint>/v1/logs when configured', async () => {
    const db = new FakeDb([event()]);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await exportWorkflowEventsToOtlp(db, {
      config: new FakeConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ attempted: true, exportedCount: 1, lastEventId: 'evt-1' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://collector:4318/v1/logs',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('applies a request timeout via AbortSignal (post-merge review MEDIUM-3)', async () => {
    const db = new FakeDb([event()]);
    let sawSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      sawSignal = init.signal as AbortSignal;
      return Promise.resolve({ ok: true, status: 200 });
    });
    await exportWorkflowEventsToOtlp(db, {
      config: new FakeConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5,
    });
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces an abort as a rejected promise when the collector never responds in time', async () => {
    const db = new FakeDb([event()]);
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    });
    await expect(
      exportWorkflowEventsToOtlp(db, {
        config: new FakeConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/aborted/);
  });

  it('throws when the collector returns a non-ok response', async () => {
    const db = new FakeDb([event()]);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(
      exportWorkflowEventsToOtlp(db, {
        config: new FakeConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/503/);
  });

  it('reports exportedCount 0 with no rows to export', async () => {
    const db = new FakeDb([]);
    const fetchImpl = vi.fn();
    const result = await exportWorkflowEventsToOtlp(db, {
      config: new FakeConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ attempted: true, exportedCount: 0, lastEventId: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/** Unlike `FakeDb` above (which ignores its query entirely — fine for the tests above, which
 * don't depend on filtering), this one actually applies the `occurred_at <= ?` / `id > ?` /
 * `ORDER BY id ASC LIMIT ?` clauses `exportWorkflowEventsToOtlp()` builds, so the safety-margin
 * regression below can prove the real filtering behavior, not just that some rows were returned. */
class FilteringFakeDb implements DbClient {
  constructor(private readonly rows: WorkflowEventRow[]) {}
  async query<T = Record<string, unknown>>(_sql: string, params: unknown[] = []): Promise<T[]> {
    const [watermark, sinceEventId, limit] =
      params.length === 3
        ? (params as [string, string, number])
        : [params[0] as string, undefined, params[1] as number];
    let filtered = this.rows.filter((r) => r.occurred_at <= watermark);
    if (sinceEventId) filtered = filtered.filter((r) => r.id > sinceEventId);
    filtered = [...filtered].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return filtered.slice(0, limit) as unknown as T[];
  }
  async execute(): Promise<void> {}
  async executeAffected(): Promise<number> {
    return 0;
  }
  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async close(): Promise<void> {}
}

describe('exportWorkflowEventsToOtlp: safety-margin cursor fix (PR #73 review, MEDIUM-1)', () => {
  it('excludes an event more recent than the safety margin, even if its id sorts after an eligible one', async () => {
    const fixedNow = new Date('2026-01-01T00:10:00.000Z');
    const db = new FilteringFakeDb([
      // 'evt-old' is eligible (8 minutes old); 'evt-recent' is not (30 seconds old) despite
      // sorting after 'evt-old' lexically -- the exact shape of the bug this margin closes: a
      // slow transaction generating a lower id could still be in flight when a naive
      // `id > cursor` cursor would otherwise consider this range fully settled.
      event({ id: 'evt-old', occurred_at: '2026-01-01T00:02:00.000Z' }),
      event({ id: 'evt-recent', occurred_at: '2026-01-01T00:09:30.000Z' }),
    ]);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await exportWorkflowEventsToOtlp(db, {
      config: new FakeConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => fixedNow,
    });
    expect(result).toEqual({ attempted: true, exportedCount: 1, lastEventId: 'evt-old' });
  });

  it('includes the previously-too-recent event once it falls outside the margin on a later call', async () => {
    const db = new FilteringFakeDb([
      event({ id: 'evt-old', occurred_at: '2026-01-01T00:02:00.000Z' }),
      event({ id: 'evt-recent', occurred_at: '2026-01-01T00:09:30.000Z' }),
    ]);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const first = await exportWorkflowEventsToOtlp(db, {
      config: new FakeConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date('2026-01-01T00:10:00.000Z'),
    });
    expect(first.lastEventId).toBe('evt-old');

    const second = await exportWorkflowEventsToOtlp(db, {
      config: new FakeConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sinceEventId: first.lastEventId ?? undefined,
      now: () => new Date('2026-01-01T00:20:00.000Z'), // 10 minutes later: past the margin now
    });
    expect(second).toEqual({ attempted: true, exportedCount: 1, lastEventId: 'evt-recent' });
  });

  it('respects a caller-supplied safetyMarginMs override', async () => {
    const db = new FilteringFakeDb([
      event({ id: 'evt-1', occurred_at: '2026-01-01T00:09:45.000Z' }),
    ]);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await exportWorkflowEventsToOtlp(db, {
      config: new FakeConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date('2026-01-01T00:10:00.000Z'),
      safetyMarginMs: 10_000, // 10s margin -- 15s-old event is eligible
    });
    expect(result.exportedCount).toBe(1);
  });
});
