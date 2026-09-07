import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';
import { createRunCommand } from './run.js';

function fakeFetch(path: string, result: unknown) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const actualPath = new URL(url).pathname;
    if (actualPath === path) {
      expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
      return { ok: true, status: 202, json: async () => result } as Response;
    }
    throw new Error(`unexpected fetch to ${actualPath}`);
  });
}

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchImpl.mock.calls[0]!;
  return JSON.parse((init as RequestInit).body as string);
}

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createRunCommand());
  return program;
}

describe('CLI run command', () => {
  beforeEach(() => {
    process.env['MINICODER_API_URL'] = 'http://localhost:4000';
    process.env['MINICODER_API_KEY'] = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env['MINICODER_API_URL'];
    delete process.env['MINICODER_API_KEY'];
  });

  it('run coder enqueues request-coder-run and reports the run id', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch('/commands/request-coder-run', { triggerdevRunId: 'run-1', accepted: true }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'coder',
      '--project',
      'proj1',
      '--feature-run',
      'fr1',
      '--coder-adapter',
      'CodexCoderAdapter',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"triggerdevRunId": "run-1"');
  });

  it('run merge-gate enqueues recompute-merge-gate', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch('/commands/recompute-merge-gate', { triggerdevRunId: 'run-2', accepted: true }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'merge-gate',
      '--project',
      'proj1',
      '--feature-run',
      'fr1',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"triggerdevRunId": "run-2"');
  });

  it('run review enqueues request-review with an optional --arbiter-adapter', async () => {
    const fetchImpl = fakeFetch('/commands/request-review', {
      triggerdevRunId: 'run-3',
      accepted: true,
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'review',
      '--project',
      'proj1',
      '--feature-run',
      'fr1',
      '--reviewer-adapter',
      'ClaudeReviewerAdapter',
      '--arbiter-adapter',
      'ClaudeArbiterAdapter',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"triggerdevRunId": "run-3"');
    expect(bodyOf(fetchImpl)).toEqual({
      projectId: 'proj1',
      featureRunId: 'fr1',
      reviewerAdapterName: 'ClaudeReviewerAdapter',
      arbiterAdapterName: 'ClaudeArbiterAdapter',
    });
  });

  it('run review omits arbiterAdapterName when --arbiter-adapter is not passed', async () => {
    const fetchImpl = fakeFetch('/commands/request-review', {
      triggerdevRunId: 'run-3',
      accepted: true,
    });
    vi.stubGlobal('fetch', fetchImpl);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'review',
      '--project',
      'proj1',
      '--feature-run',
      'fr1',
      '--reviewer-adapter',
      'ClaudeReviewerAdapter',
      '--json',
    ]);

    expect(bodyOf(fetchImpl).arbiterAdapterName).toBeUndefined();
  });

  it('run fixes enqueues request-fixes', async () => {
    const fetchImpl = fakeFetch('/commands/request-fixes', {
      triggerdevRunId: 'run-4',
      accepted: true,
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'fixes',
      '--project',
      'proj1',
      '--feature-run',
      'fr1',
      '--reviewer-adapter',
      'ClaudeReviewerAdapter',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"triggerdevRunId": "run-4"');
    expect(bodyOf(fetchImpl)).toEqual({
      projectId: 'proj1',
      featureRunId: 'fr1',
      reviewerAdapterName: 'ClaudeReviewerAdapter',
    });
  });

  it('run plan-generation enqueues request-plan-generation', async () => {
    const fetchImpl = fakeFetch('/commands/request-plan-generation', {
      triggerdevRunId: 'run-5',
      accepted: true,
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'plan-generation',
      '--project',
      'proj1',
      '--assessment',
      'assessment1',
      '--planner-adapter',
      'GenericLLMPlannerAdapter',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"triggerdevRunId": "run-5"');
    expect(bodyOf(fetchImpl)).toEqual({
      projectId: 'proj1',
      assessmentId: 'assessment1',
      plannerAdapterName: 'GenericLLMPlannerAdapter',
    });
  });

  it('run backlog-generation enqueues request-backlog-generation', async () => {
    const fetchImpl = fakeFetch('/commands/request-backlog-generation', {
      triggerdevRunId: 'run-6',
      accepted: true,
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'backlog-generation',
      '--project',
      'proj1',
      '--plan',
      'plan1',
      '--planner-adapter',
      'GenericLLMPlannerAdapter',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"triggerdevRunId": "run-6"');
    expect(bodyOf(fetchImpl)).toEqual({
      projectId: 'proj1',
      planId: 'plan1',
      plannerAdapterName: 'GenericLLMPlannerAdapter',
    });
  });

  it('run start-next-feature enqueues request-start-next-feature with no --feature-run (auto-discovery)', async () => {
    const fetchImpl = fakeFetch('/commands/request-start-next-feature', {
      triggerdevRunId: 'run-7',
      accepted: true,
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'start-next-feature',
      '--project',
      'proj1',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"triggerdevRunId": "run-7"');
    expect(bodyOf(fetchImpl)).toEqual({ projectId: 'proj1' });
  });

  it('run start-next-feature passes --feature-run through when supplied (targeted retry)', async () => {
    const fetchImpl = fakeFetch('/commands/request-start-next-feature', {
      triggerdevRunId: 'run-8',
      accepted: true,
    });
    vi.stubGlobal('fetch', fetchImpl);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'start-next-feature',
      '--project',
      'proj1',
      '--feature-run',
      'fr1',
      '--json',
    ]);

    expect(bodyOf(fetchImpl)).toEqual({ projectId: 'proj1', featureRunId: 'fr1' });
  });

  it('run reconciliation enqueues request-reconciliation with no --feature-run (project-wide pass)', async () => {
    const fetchImpl = fakeFetch('/commands/request-reconciliation', {
      triggerdevRunId: 'run-9',
      accepted: true,
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'reconciliation',
      '--project',
      'proj1',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"triggerdevRunId": "run-9"');
    expect(bodyOf(fetchImpl)).toEqual({ projectId: 'proj1' });
  });

  it('run reconciliation passes --feature-run through when supplied (scoped pass)', async () => {
    const fetchImpl = fakeFetch('/commands/request-reconciliation', {
      triggerdevRunId: 'run-10',
      accepted: true,
    });
    vi.stubGlobal('fetch', fetchImpl);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'reconciliation',
      '--project',
      'proj1',
      '--feature-run',
      'fr1',
      '--json',
    ]);

    expect(bodyOf(fetchImpl)).toEqual({ projectId: 'proj1', featureRunId: 'fr1' });
  });

  it('honors a caller-supplied --idempotency-key instead of minting a new one', async () => {
    const fetchImpl = fakeFetch('/commands/request-coder-run', {
      triggerdevRunId: 'run-1',
      accepted: true,
    });
    vi.stubGlobal('fetch', fetchImpl);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'coder',
      '--project',
      'proj1',
      '--feature-run',
      'fr1',
      '--coder-adapter',
      'CodexCoderAdapter',
      '--idempotency-key',
      'my-fixed-retry-key',
      '--json',
    ]);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBe('my-fixed-retry-key');
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status < 300, status, json: async () => body } as Response;
}

interface WatchFetchOptions {
  featureRunId: string;
  /** One `current_execution_state` per `GET /feature-runs/:id` call; the last value repeats once
   * exhausted. */
  stateSequence: string[];
  /** One `activeFeatureRun` per `GET /active-feature` call (only reached when `--feature-run` is
   * omitted); the last value repeats once exhausted. */
  activeFeatureSequence?: (Record<string, unknown> | null)[];
  mergeResponse?: { status: number; body: unknown };
}

/** A stateful fetch mock for the `run feature --watch` loop: routes by method+path, popping the
 * next value off `stateSequence`/`activeFeatureSequence` per matching call (mirroring how the
 * real backend's state actually advances between polls) rather than the single-path
 * `fakeFetch()` helper above, which can't model a multi-tick poll loop. */
function fakeWatchFetch(opts: WatchFetchOptions) {
  let stateIdx = 0;
  let activeIdx = 0;
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = u.pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, body });

    if (method === 'GET' && path === '/active-feature') {
      const seq = opts.activeFeatureSequence ?? [];
      const val = seq[Math.min(activeIdx, Math.max(seq.length - 1, 0))] ?? null;
      activeIdx++;
      return jsonResponse(200, { automationState: 'running', activeFeatureRun: val });
    }
    if (method === 'GET' && path === `/feature-runs/${opts.featureRunId}`) {
      const state =
        opts.stateSequence[Math.min(stateIdx, opts.stateSequence.length - 1)] ?? 'coding';
      stateIdx++;
      return jsonResponse(200, {
        id: opts.featureRunId,
        feature_request_id: 'fr1',
        attempt_no: 1,
        current_execution_state: state,
        lock_id: null,
        started_at: null,
        ended_at: null,
        outcome: null,
        version: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    }
    if (method === 'POST' && path === '/commands/merge-if-ready') {
      const r = opts.mergeResponse ?? { status: 200, body: { merged: true, mergeSha: 'abc123' } };
      return jsonResponse(r.status, r.body);
    }
    if (method === 'POST') {
      return jsonResponse(202, { triggerdevRunId: `run-${calls.length}`, accepted: true });
    }
    throw new Error(`fakeWatchFetch: unexpected ${method} ${path}`);
  });
  return { fn, calls };
}

describe('CLI run feature --watch', () => {
  beforeEach(() => {
    process.env['MINICODER_API_URL'] = 'http://localhost:4000';
    process.env['MINICODER_API_KEY'] = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env['MINICODER_API_URL'];
    delete process.env['MINICODER_API_KEY'];
    process.exitCode = undefined;
  });

  it('drives an explicit --feature-run through coding -> ... -> merged and exits 0', async () => {
    const { fn, calls } = fakeWatchFetch({
      featureRunId: 'fr1',
      stateSequence: [
        'coding',
        'code_pushed',
        'pr_opened',
        'ci_running',
        'under_review',
        'approved_by_policy',
        'merged',
      ],
    });
    vi.stubGlobal('fetch', fn);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'feature',
      '--project',
      'proj1',
      '--feature-run',
      'fr1',
      '--coder-adapter',
      'CodexCoderAdapter',
      '--reviewer-adapter',
      'ClaudeReviewerAdapter',
      '--watch',
      '--poll-interval-ms',
      '1',
      '--timeout-ms',
      '10000',
    ]);

    expect(process.exitCode).toBe(0);
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('POST /commands/request-coder-run');
    expect(paths).toContain('POST /commands/request-reconciliation');
    expect(paths).toContain('POST /commands/request-review');
    expect(paths).toContain('POST /commands/recompute-merge-gate');
    expect(paths).toContain('POST /commands/merge-if-ready');
  });

  it('auto-discovers a feature run when --feature-run is omitted', async () => {
    const { fn, calls } = fakeWatchFetch({
      featureRunId: 'fr2',
      stateSequence: ['coding', 'merged'],
      activeFeatureSequence: [null, { id: 'fr2', current_execution_state: 'coding' }],
    });
    vi.stubGlobal('fetch', fn);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'feature',
      '--project',
      'proj1',
      '--coder-adapter',
      'CodexCoderAdapter',
      '--reviewer-adapter',
      'ClaudeReviewerAdapter',
      '--watch',
      '--poll-interval-ms',
      '1',
      '--timeout-ms',
      '10000',
    ]);

    expect(process.exitCode).toBe(0);
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('POST /commands/request-start-next-feature');
    expect(paths).toContain('GET /active-feature');
    expect(paths).toContain(`GET /feature-runs/fr2`);
  });

  it('stops at human_required with a non-zero exit code, never guessing past it', async () => {
    const { fn } = fakeWatchFetch({
      featureRunId: 'fr3',
      stateSequence: ['under_review', 'human_required'],
    });
    vi.stubGlobal('fetch', fn);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'feature',
      '--project',
      'proj1',
      '--feature-run',
      'fr3',
      '--coder-adapter',
      'CodexCoderAdapter',
      '--reviewer-adapter',
      'ClaudeReviewerAdapter',
      '--watch',
      '--poll-interval-ms',
      '1',
      '--timeout-ms',
      '10000',
    ]);

    expect(process.exitCode).toBe(1);
  });

  it('stops at approved_by_policy with --no-merge, without calling merge-if-ready', async () => {
    const { fn, calls } = fakeWatchFetch({
      featureRunId: 'fr4',
      stateSequence: ['approved_by_policy'],
    });
    vi.stubGlobal('fetch', fn);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'feature',
      '--project',
      'proj1',
      '--feature-run',
      'fr4',
      '--coder-adapter',
      'CodexCoderAdapter',
      '--reviewer-adapter',
      'ClaudeReviewerAdapter',
      '--watch',
      '--no-merge',
      '--poll-interval-ms',
      '1',
      '--timeout-ms',
      '10000',
    ]);

    expect(process.exitCode).toBe(2);
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).not.toContain('POST /commands/merge-if-ready');
  });

  it('stops with exit code 2 when merge-if-ready returns 403 (insufficient role)', async () => {
    const { fn } = fakeWatchFetch({
      featureRunId: 'fr5',
      stateSequence: ['approved_by_policy'],
      mergeResponse: {
        status: 403,
        body: {
          type: 'authorization-error',
          title: 'Forbidden',
          status: 403,
          detail: 'requires approver role',
        },
      },
    });
    vi.stubGlobal('fetch', fn);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'run',
      'feature',
      '--project',
      'proj1',
      '--feature-run',
      'fr5',
      '--coder-adapter',
      'CodexCoderAdapter',
      '--reviewer-adapter',
      'ClaudeReviewerAdapter',
      '--watch',
      '--poll-interval-ms',
      '1',
      '--timeout-ms',
      '10000',
    ]);

    expect(process.exitCode).toBe(2);
  });

  it('requires --watch', async () => {
    await expect(
      makeProgram().parseAsync([
        'node',
        'minicoder',
        'run',
        'feature',
        '--project',
        'proj1',
        '--feature-run',
        'fr1',
        '--coder-adapter',
        'CodexCoderAdapter',
        '--reviewer-adapter',
        'ClaudeReviewerAdapter',
      ]),
    ).rejects.toThrow();
  });
});
