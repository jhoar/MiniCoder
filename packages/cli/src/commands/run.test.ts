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
});
