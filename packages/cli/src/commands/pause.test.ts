import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';
import { createPauseCommand } from './pause.js';

function fakeFetch(status: { workflowState: unknown }, pauseResult: unknown) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/status') {
      return { ok: true, status: 200, json: async () => status } as Response;
    }
    if (path === '/commands/pause-automation') {
      expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
      return { ok: true, status: 200, json: async () => pauseResult } as Response;
    }
    throw new Error(`unexpected fetch to ${path}`);
  });
}

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createPauseCommand());
  return program;
}

describe('CLI pause command', () => {
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
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync(['node', 'minicoder', 'pause', '--project', 'proj1']);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/--yes/);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('fetches the current version and dispatches pause-automation with a fresh idempotency key', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(
        {
          workflowState: { automation_state: 'running', active_feature_run_id: null, version: 5 },
        },
        {
          command_id: 'c1',
          accepted: true,
          resulting_state: 'paused_by_operator',
          emitted_event_ids: [],
        },
      ),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'pause',
      '--project',
      'proj1',
      '--yes',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"resultingState": "paused_by_operator"');
  });
});
