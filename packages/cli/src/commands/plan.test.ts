import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';
import { createPlanCommand } from './plan.js';

function fakeFetch(plans: unknown, commandPath: string, commandResult: unknown) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/plans') {
      return { ok: true, status: 200, json: async () => plans } as Response;
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

  it('submit-for-approval fetches the plan version and dispatches submit-plan-for-approval', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(
        { items: [{ id: 'plan1', version: 0 }], nextCursor: null },
        '/commands/submit-plan-for-approval',
        {
          command_id: 'c1',
          accepted: true,
          resulting_state: 'pending_approval',
          emitted_event_ids: [],
        },
      ),
    );
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

  it('activate fetches the plan version and dispatches activate-plan', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(
        { items: [{ id: 'plan1', version: 2 }], nextCursor: null },
        '/commands/activate-plan',
        {
          command_id: 'c1',
          accepted: true,
          resulting_state: 'activated_for_execution',
          emitted_event_ids: [],
        },
      ),
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
});
