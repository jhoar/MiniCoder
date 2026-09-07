import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';
import { createFindingsCommand } from './findings.js';

function fakeFetch(path: string, result: unknown) {
  return vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const actualPath = new URL(url).pathname;
    if (actualPath === path) {
      return { ok: true, status: 200, json: async () => result } as Response;
    }
    throw new Error(`unexpected fetch to ${actualPath}`);
  });
}

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createFindingsCommand());
  return program;
}

describe('CLI findings resolve command (issue #116)', () => {
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

  it('posts a deferred disposition when --dismiss is omitted', async () => {
    const fetchImpl = fakeFetch('/commands/resolve-review-finding', {
      findingId: 'finding1',
      dismissed: false,
      alreadyResolved: false,
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'findings',
      'resolve',
      '--finding-id',
      'finding1',
      '--note',
      'still wants a fix',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"dismissed": false');
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      findingId: 'finding1',
      dismiss: false,
      note: 'still wants a fix',
    });
  });

  it('posts a dismiss disposition when --dismiss is passed', async () => {
    const fetchImpl = fakeFetch('/commands/resolve-review-finding', {
      findingId: 'finding1',
      dismissed: true,
      alreadyResolved: false,
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'findings',
      'resolve',
      '--finding-id',
      'finding1',
      '--dismiss',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"dismissed": true');
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      findingId: 'finding1',
      dismiss: true,
      note: undefined,
    });
  });
});

describe('CLI findings (bare/view) command', () => {
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

  it('lists findings for a feature run by default (no subcommand)', async () => {
    const fetchImpl = fakeFetch('/review-findings', { items: [], nextCursor: null });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'findings',
      '--feature-run',
      'run1',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"items": []');
  });
});
