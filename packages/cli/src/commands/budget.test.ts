import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';
import { createBudgetCommand } from './budget.js';

function fakeFetch(status: { workflowState: unknown }, overrideResult: unknown) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/status') {
      return { ok: true, status: 200, json: async () => status } as Response;
    }
    if (path === '/commands/approve-budget-override') {
      expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
      return { ok: true, status: 200, json: async () => overrideResult } as Response;
    }
    throw new Error(`unexpected fetch to ${path}`);
  });
}

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createBudgetCommand());
  return program;
}

describe('CLI budget approve-override command', () => {
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

  it('refuses to run without --yes', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'budget',
      'approve-override',
      '--project',
      'proj1',
      '--policy',
      'policy1',
      '--reason',
      'extra spend',
    ]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/--yes/);
  });

  it('picks the budget-override-waiting idempotency key template for a soft breach', async () => {
    const fetchImpl = fakeFetch(
      {
        workflowState: {
          automation_state: 'waiting_for_budget_approval',
          active_feature_run_id: null,
          version: 5,
        },
      },
      { command_id: 'c1', accepted: true, resulting_state: 'running', emitted_event_ids: [] },
    );
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'budget',
      'approve-override',
      '--project',
      'proj1',
      '--policy',
      'policy1',
      '--reason',
      'extra spend',
      '--yes',
      '--json',
    ]);

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect((init?.headers as Record<string, string>)['Idempotency-Key']).toMatch(
      /^budget-override-waiting:/,
    );
    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"resultingState": "running"');
  });

  it('errors when automation is not in a budget-paused state', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(
        { workflowState: { automation_state: 'running', active_feature_run_id: null, version: 5 } },
        {},
      ),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'budget',
      'approve-override',
      '--project',
      'proj1',
      '--policy',
      'policy1',
      '--reason',
      'extra spend',
      '--yes',
      '--json',
    ]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/nothing to override/);
  });
});
