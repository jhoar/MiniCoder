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
    const attrMap = Object.fromEntries(
      record.attributes.map((a) => [a.key, a.value.stringValue]),
    );
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
