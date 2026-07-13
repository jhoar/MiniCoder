import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { createObservabilityCommand } from './observability.js';

interface WorkflowEventRow {
  id: string;
  feature_run_id: string | null;
  project_id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  actor: string | null;
  occurred_at: string;
}

interface CursorValue {
  lastEventId: string;
  lastOccurredAt: string;
}

/** Minimal in-memory DbClient backing both `workflow_events` (read-only fixture rows) and
 * `observability_export_cursors` (the cursor this command reads/writes) — enough to exercise the
 * real `exportWorkflowEventsToOtlp()`/`get|setObservabilityExportCursor()` functions end to end
 * without a real migrated database. */
function makeFakeDb(events: WorkflowEventRow[]) {
  const cursors = new Map<string, CursorValue>();
  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.includes('FROM observability_export_cursors')) {
        const id = params[0] as string;
        const cursor = cursors.get(id);
        return (cursor
          ? [
              {
                id,
                last_event_id: cursor.lastEventId,
                last_occurred_at: cursor.lastOccurredAt,
                updated_at: 'x',
              },
            ]
          : []) as unknown as T[];
      }
      if (sql.includes('FROM workflow_events')) {
        // Mirrors exportWorkflowEventsToOtlp()'s real param order:
        //   no cursor:   [watermark, limit]                                     (length 2)
        //   with cursor: [watermark, sinceOccurredAt, sinceOccurredAt, sinceEventId, limit] (length 5)
        const watermark = params[0] as string;
        const hasCursor = params.length === 5;
        const sinceOccurredAt = hasCursor ? (params[1] as string) : undefined;
        const sinceEventId = hasCursor ? (params[3] as string) : undefined;
        let filtered = events.filter((e) => e.occurred_at <= watermark);
        if (sinceOccurredAt !== undefined && sinceEventId !== undefined) {
          filtered = filtered.filter(
            (e) =>
              e.occurred_at > sinceOccurredAt ||
              (e.occurred_at === sinceOccurredAt && e.id > sinceEventId),
          );
        }
        filtered = [...filtered].sort((a, b) => {
          if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? -1 : 1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        return filtered as unknown as T[];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute(sql: string, params: unknown[] = []): Promise<void> {
      if (sql.includes('INSERT INTO observability_export_cursors')) {
        const [id, lastEventId, lastOccurredAt] = params as [string, string, string];
        cursors.set(id, { lastEventId, lastOccurredAt });
        return;
      }
      throw new Error(`unexpected execute: ${sql}`);
    },
    async executeAffected(): Promise<number> {
      return 0;
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(this);
    },
    async close(): Promise<void> {},
    _cursors: cursors,
  };
}

let fakeDb: ReturnType<typeof makeFakeDb>;

vi.mock('../db-client.js', () => ({
  createDbClientFromEnv: async () => fakeDb,
}));

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createObservabilityCommand());
  return program;
}

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

describe('CLI observability export-otel command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  });

  it('no-ops and leaves the cursor untouched when OTEL_EXPORTER_OTLP_ENDPOINT is unset', async () => {
    fakeDb = makeFakeDb([event()]);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync(['node', 'minicoder', 'observability', 'export-otel']);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fakeDb._cursors.size).toBe(0);
    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"attempted": false');
  });

  it('exports and advances the cursor on a real run, then resumes from it on the next invocation', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://collector:4318';
    fakeDb = makeFakeDb([
      event({ id: 'evt-1', occurred_at: '2026-01-01T00:00:00.000Z' }),
      event({ id: 'evt-2', occurred_at: '2026-01-01T00:00:01.000Z' }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync(['node', 'minicoder', 'observability', 'export-otel']);

    expect(fakeDb._cursors.get('workflow_events_otlp')?.lastEventId).toBe('evt-2');
    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"exportedCount": 2');

    // Second invocation simulates a later cron tick against a DB that already has the persisted
    // cursor plus one new event — must only see the event strictly after the cursor.
    logSpy.mockClear();
    const db2 = makeFakeDb([
      event({ id: 'evt-1', occurred_at: '2026-01-01T00:00:00.000Z' }),
      event({ id: 'evt-2', occurred_at: '2026-01-01T00:00:01.000Z' }),
      event({ id: 'evt-3', occurred_at: '2026-01-01T00:00:02.000Z' }),
    ]);
    db2._cursors.set('workflow_events_otlp', {
      lastEventId: 'evt-2',
      lastOccurredAt: '2026-01-01T00:00:01.000Z',
    });
    fakeDb = db2;

    await makeProgram().parseAsync(['node', 'minicoder', 'observability', 'export-otel']);

    expect(fakeDb._cursors.get('workflow_events_otlp')?.lastEventId).toBe('evt-3');
    const printed2 = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed2).toContain('"exportedCount": 1');
  });

  it('rejects a non-positive --limit before touching the database', async () => {
    fakeDb = makeFakeDb([event()]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'observability',
      'export-otel',
      '--limit',
      '0',
    ]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/--limit/);
  });

  // PR #73 review fix (LOW-1): the error message says "positive integer," but the check only
  // verified finite/positive — a decimal silently passed through.
  it('rejects a non-integer --limit', async () => {
    fakeDb = makeFakeDb([event()]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'observability',
      'export-otel',
      '--limit',
      '1.5',
    ]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/--limit/);
  });

  it('uses a distinct cursor row per --cursor-id', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://collector:4318';
    fakeDb = makeFakeDb([event({ id: 'evt-1' })]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'observability',
      'export-otel',
      '--cursor-id',
      'secondary-target',
    ]);

    expect(fakeDb._cursors.has('secondary-target')).toBe(true);
    expect(fakeDb._cursors.has('workflow_events_otlp')).toBe(false);
  });

  // PR #73 review round 2 (MEDIUM-2): resuming past a UUID-keyed workflow_events row (e.g. from
  // `state repair --apply`) must not skip a later, ordinary event whose id happens to sort lower.
  it('resumes correctly past a UUID-keyed event via the composite (occurred_at, id) cursor', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://collector:4318';
    fakeDb = makeFakeDb([
      event({ id: 'ffffffff-uuid-from-state-repair', occurred_at: '2026-01-01T00:00:00.000Z' }),
      event({ id: '1700000005000-later', occurred_at: '2026-01-01T00:00:01.000Z' }),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync(['node', 'minicoder', 'observability', 'export-otel']);

    expect(fakeDb._cursors.get('workflow_events_otlp')?.lastEventId).toBe('1700000005000-later');
    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"exportedCount": 2');
  });
});
