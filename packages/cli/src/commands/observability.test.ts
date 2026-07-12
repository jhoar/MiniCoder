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

/** Minimal in-memory DbClient backing both `workflow_events` (read-only fixture rows) and
 * `observability_export_cursors` (the cursor this command reads/writes) — enough to exercise the
 * real `exportWorkflowEventsToOtlp()`/`get|setObservabilityExportCursor()` functions end to end
 * without a real migrated database. */
function makeFakeDb(events: WorkflowEventRow[]) {
  const cursors = new Map<string, string>();
  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.includes('FROM observability_export_cursors')) {
        const id = params[0] as string;
        const lastEventId = cursors.get(id);
        return (lastEventId
          ? [{ id, last_event_id: lastEventId, updated_at: 'x' }]
          : []) as unknown as T[];
      }
      if (sql.includes('FROM workflow_events')) {
        const sinceId = sql.includes('WHERE id > ?') ? (params[0] as string) : undefined;
        const filtered = sinceId ? events.filter((e) => e.id > sinceId) : events;
        return filtered as unknown as T[];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute(sql: string, params: unknown[] = []): Promise<void> {
      if (sql.includes('INSERT INTO observability_export_cursors')) {
        const [id, lastEventId] = params as [string, string];
        cursors.set(id, lastEventId);
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
    fakeDb = makeFakeDb([event({ id: 'evt-1' }), event({ id: 'evt-2' })]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync(['node', 'minicoder', 'observability', 'export-otel']);

    expect(fakeDb._cursors.get('workflow_events_otlp')).toBe('evt-2');
    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"exportedCount": 2');

    // Second invocation simulates a later cron tick against a DB that already has the persisted
    // cursor plus one new event — must only see the event strictly after the cursor.
    logSpy.mockClear();
    const db2 = makeFakeDb([
      event({ id: 'evt-1' }),
      event({ id: 'evt-2' }),
      event({ id: 'evt-3' }),
    ]);
    db2._cursors.set('workflow_events_otlp', 'evt-2');
    fakeDb = db2;

    await makeProgram().parseAsync(['node', 'minicoder', 'observability', 'export-otel']);

    expect(fakeDb._cursors.get('workflow_events_otlp')).toBe('evt-3');
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
});
