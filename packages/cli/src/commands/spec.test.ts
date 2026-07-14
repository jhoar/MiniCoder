import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { createSpecCommand } from './spec.js';

function fakeFetch(ingestResult: unknown) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/commands/ingest-specification') {
      expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
      return { ok: true, status: 200, json: async () => ingestResult } as Response;
    }
    throw new Error(`unexpected fetch to ${path}`);
  });
}

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createSpecCommand());
  return program;
}

describe('CLI spec ingest command', () => {
  let specFile: string;

  beforeEach(() => {
    process.env['MINICODER_API_URL'] = 'http://localhost:4000';
    process.env['MINICODER_API_KEY'] = 'test-key';
    specFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-test-')), 'spec.md');
    fs.writeFileSync(specFile, 'spec content', 'utf-8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env['MINICODER_API_URL'];
    delete process.env['MINICODER_API_KEY'];
    fs.rmSync(path.dirname(specFile), { recursive: true, force: true });
  });

  it('reads the file and dispatches ingest-specification with a fresh idempotency key', async () => {
    const fetchImpl = fakeFetch({
      command_id: 'c1',
      accepted: true,
      resulting_state: 'ingested',
      emitted_event_ids: [],
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'spec',
      'ingest',
      specFile,
      '--project',
      'proj1',
      '--json',
    ]);

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toMatchObject({
      projectId: 'proj1',
      content: 'spec content',
      contentType: 'text/plain',
    });
    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"resultingState": "ingested"');
  });
});
