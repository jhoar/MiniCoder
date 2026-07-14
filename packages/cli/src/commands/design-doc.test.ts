import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';
import { createDesignDocCommand } from './design-doc.js';

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
  program.addCommand(createDesignDocCommand());
  return program;
}

describe('CLI design-doc request-run command', () => {
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

  it('enqueues request-design-doc and reports the run id', async () => {
    const fetchImpl = fakeFetch('/commands/request-design-doc', {
      triggerdevRunId: 'run-1',
      accepted: true,
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'design-doc',
      'request-run',
      '--project',
      'proj1',
      '--documentation-adapter',
      'ClaudeDocumentationAdapter',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"triggerdevRunId": "run-1"');
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      projectId: 'proj1',
      documentationAdapterName: 'ClaudeDocumentationAdapter',
    });
  });

  it('honors a caller-supplied --idempotency-key instead of minting a new one (code-review fix)', async () => {
    const fetchImpl = fakeFetch('/commands/request-design-doc', {
      triggerdevRunId: 'run-1',
      accepted: true,
    });
    vi.stubGlobal('fetch', fetchImpl);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'design-doc',
      'request-run',
      '--project',
      'proj1',
      '--documentation-adapter',
      'ClaudeDocumentationAdapter',
      '--idempotency-key',
      'stable-key',
      '--json',
    ]);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBe('stable-key');
  });
});
