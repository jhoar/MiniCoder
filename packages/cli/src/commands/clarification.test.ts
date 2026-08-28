import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';
import { createClarificationCommand } from './clarification.js';

function fakeFetch(sessionDetail: unknown, answerResult: unknown) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/clarification-sessions/sess1') {
      return { ok: true, status: 200, json: async () => sessionDetail } as Response;
    }
    if (path === '/commands/record-clarification-answer') {
      expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
      const body = JSON.parse(init?.body as string);
      expect(body.expectedQuestionVersion).toBe(3);
      return { ok: true, status: 200, json: async () => answerResult } as Response;
    }
    throw new Error(`unexpected fetch to ${path}`);
  });
}

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createClarificationCommand());
  return program;
}

describe('CLI clarification answer command', () => {
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

  it('fetches expectedQuestionVersion from the session and dispatches the answer', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(
        {
          session: { id: 'sess1' },
          questions: [{ id: 'q1', version: 3 }],
        },
        {
          command_id: 'c1',
          accepted: true,
          resulting_state: 'clarification_required',
          emitted_event_ids: [],
        },
      ),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'clarification',
      'answer',
      '--project',
      'proj1',
      '--session',
      'sess1',
      '--question',
      'q1',
      '--text',
      'the answer',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"resultingState": "clarification_required"');
  });

  it('errors when the question is not found in the session', async () => {
    vi.stubGlobal('fetch', fakeFetch({ session: { id: 'sess1' }, questions: [] }, {}));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'clarification',
      'answer',
      '--project',
      'proj1',
      '--session',
      'sess1',
      '--question',
      'missing-q',
      '--text',
      'the answer',
      '--json',
    ]);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(errSpy.mock.calls.join(' ')).toMatch(/not found/);
  });
});

describe('CLI clarification start/complete commands (issue #81)', () => {
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

  function fakeSessionFetch(commandPath: string, expectedVersion: number, commandResult: unknown) {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/clarification-sessions/sess1') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ session: { id: 'sess1', version: expectedVersion }, questions: [] }),
        } as Response;
      }
      if (path === commandPath) {
        expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
        const body = JSON.parse(init?.body as string);
        expect(body.expectedVersion).toBe(expectedVersion);
        return { ok: true, status: 200, json: async () => commandResult } as Response;
      }
      throw new Error(`unexpected fetch to ${path}`);
    });
  }

  it('start fetches the session version and dispatches start-clarification', async () => {
    const fetchImpl = fakeSessionFetch('/commands/start-clarification', 2, {
      command_id: 'c1',
      accepted: true,
      resulting_state: 'clarification_in_progress',
      emitted_event_ids: [],
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'clarification',
      'start',
      '--project',
      'proj1',
      '--session',
      'sess1',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"resultingState": "clarification_in_progress"');
  });

  it('complete fetches the session version and dispatches complete-clarification', async () => {
    const fetchImpl = fakeSessionFetch('/commands/complete-clarification', 5, {
      command_id: 'c1',
      accepted: true,
      resulting_state: 'clarification_complete',
      emitted_event_ids: [],
    });
    vi.stubGlobal('fetch', fetchImpl);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync([
      'node',
      'minicoder',
      'clarification',
      'complete',
      '--project',
      'proj1',
      '--session',
      'sess1',
      '--json',
    ]);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"resultingState": "clarification_complete"');
  });
});
