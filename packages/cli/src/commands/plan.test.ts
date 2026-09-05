import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';
import { createPlanCommand } from './plan.js';

function fakeFetch(plan: unknown, commandPath: string, commandResult: unknown) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/plans/plan1') {
      return { ok: true, status: 200, json: async () => plan } as Response;
    }
    if (path === commandPath) {
      expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
      return { ok: true, status: 200, json: async () => commandResult } as Response;
    }
    throw new Error(`unexpected fetch to ${path}`);
  });
}

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createPlanCommand());
  return program;
}

describe('CLI plan write commands', () => {
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

  it('submit-for-approval fetches the plan version via GET /plans/:id and dispatches submit-plan-for-approval', async () => {
    const fetchImpl = fakeFetch(
      { id: 'plan1', project_id: 'proj1', version: 0 },
      '/commands/submit-plan-for-approval',
      {
        command_id: 'c1',
        accepted: true,
        resulting_state: 'pending_approval',
        emitted_event_ids: [],
      },
    );
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'plan',
      'submit-for-approval',
      '--project',
      'proj1',
      '--plan',
      'plan1',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"resultingState": "pending_approval"');
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect(JSON.parse(init?.body as string)).toMatchObject({
      planId: 'plan1',
      projectId: 'proj1',
      expectedVersion: 0,
    });
  });

  it("does not incorrectly report a valid plan as missing when it isn't on the first listing page (regression for the pagination bug)", async () => {
    // A plan.ts implementation that scanned only listImplementationPlans()'s first page (instead
    // of using GET /plans/:id directly) would 404 here even though the plan genuinely exists —
    // this fake fetch has no /plans (list) route registered at all, so any such regression fails
    // loudly instead of silently passing by coincidence.
    const fetchImpl = fakeFetch(
      { id: 'plan1', project_id: 'proj1', version: 4 },
      '/commands/activate-plan',
      {
        command_id: 'c1',
        accepted: true,
        resulting_state: 'activated_for_execution',
        emitted_event_ids: [],
      },
    );
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'plan',
      'activate',
      '--project',
      'proj1',
      '--plan',
      'plan1',
      '--yes',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"resultingState": "activated_for_execution"');
  });

  it('rejects a plan id that exists but belongs to a different project', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({ id: 'plan1', project_id: 'other-project', version: 0 }, '', {}),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'plan',
      'submit-for-approval',
      '--project',
      'proj1',
      '--plan',
      'plan1',
      '--json',
    ]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/not found in project/);
  });

  it('approve refuses to run without --yes', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'plan',
      'approve',
      '--project',
      'proj1',
      '--plan',
      'plan1',
    ]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/--yes/);
  });

  it('approve --yes --notes forwards notes and dispatches approve-plan', async () => {
    const fetchImpl = fakeFetch(
      { id: 'plan1', project_id: 'proj1', version: 1 },
      '/commands/approve-plan',
      {
        command_id: 'c1',
        accepted: true,
        resulting_state: 'approved',
        emitted_event_ids: [],
      },
    );
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'plan',
      'approve',
      '--project',
      'proj1',
      '--plan',
      'plan1',
      '--notes',
      'looks good',
      '--yes',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"resultingState": "approved"');
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect(JSON.parse(init?.body as string)).toMatchObject({
      planId: 'plan1',
      projectId: 'proj1',
      expectedVersion: 1,
      notes: 'looks good',
    });
  });

  it('activate fetches the plan version and dispatches activate-plan', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({ id: 'plan1', project_id: 'proj1', version: 2 }, '/commands/activate-plan', {
        command_id: 'c1',
        accepted: true,
        resulting_state: 'activated_for_execution',
        emitted_event_ids: [],
      }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'plan',
      'activate',
      '--project',
      'proj1',
      '--plan',
      'plan1',
      '--yes',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"resultingState": "activated_for_execution"');
  });

  it('honors a caller-supplied --idempotency-key instead of minting a new one', async () => {
    const fetchImpl = fakeFetch(
      { id: 'plan1', project_id: 'proj1', version: 0 },
      '/commands/submit-plan-for-approval',
      {
        command_id: 'c1',
        accepted: true,
        resulting_state: 'pending_approval',
        emitted_event_ids: [],
      },
    );
    vi.stubGlobal('fetch', fetchImpl);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'plan',
      'submit-for-approval',
      '--project',
      'proj1',
      '--plan',
      'plan1',
      '--idempotency-key',
      'my-fixed-retry-key',
      '--json',
    ]);

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBe('my-fixed-retry-key');
  });
});

describe('CLI plan view --plan', () => {
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

  it('fetches the plan row and its sections and renders both when --plan is given', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = new URL(url);
      if (u.pathname === '/plans' && u.searchParams.get('projectId') === 'proj1') {
        return { ok: true, status: 200, json: async () => ({ items: [], nextCursor: null }) } as Response;
      }
      if (u.pathname === '/planning-readiness-assessments') {
        return { ok: true, status: 200, json: async () => ({ items: [], nextCursor: null }) } as Response;
      }
      if (u.pathname === '/plans/plan1') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'plan1',
            project_id: 'proj1',
            assessment_id: 'assessment1',
            state: 'draft',
            title: 'Generated Plan',
            summary: 'Generated summary',
            version: 1,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          }),
        } as Response;
      }
      if (u.pathname === '/plans/plan1/sections') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sections: [{ id: 'sec1', title: 'Overview', content: 'Build CRUD endpoints.', order_index: 0 }],
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch to ${u.pathname}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'plan',
      'view',
      '--project',
      'proj1',
      '--plan',
      'plan1',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"title": "Generated Plan"');
    expect(printed).toContain('"title": "Overview"');
    expect(printed).toContain('"content": "Build CRUD endpoints."');
  });
});

describe('CLI plan export commands (issue #81)', () => {
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

  function fakeCommandFetch(commandPath: string, commandResult: unknown) {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === commandPath) {
        expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
        return { ok: true, status: 200, json: async () => commandResult } as Response;
      }
      throw new Error(`unexpected fetch to ${path}`);
    });
  }

  it('export dispatches export-plan directly, with no expectedVersion (no /plans/:id fetch needed)', async () => {
    const fetchImpl = fakeCommandFetch('/commands/export-plan', {
      command_id: 'c1',
      accepted: true,
      resulting_state: 'exported',
      emitted_event_ids: [],
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'plan',
      'export',
      '--project',
      'proj1',
      '--plan',
      'plan1',
      '--json',
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({ planId: 'plan1', projectId: 'proj1' });
    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"resultingState": "exported"');
  });

  it('export-backlog dispatches export-backlog directly', async () => {
    const fetchImpl = fakeCommandFetch('/commands/export-backlog', {
      command_id: 'c1',
      accepted: true,
      resulting_state: 'exported',
      emitted_event_ids: [],
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'plan',
      'export-backlog',
      '--project',
      'proj1',
      '--plan',
      'plan1',
      '--json',
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({ planId: 'plan1', projectId: 'proj1' });
    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"resultingState": "exported"');
  });
});
