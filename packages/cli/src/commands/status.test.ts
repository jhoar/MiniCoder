import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';
import { createStatusCommand } from './status.js';

function fakeFetch(
  responses: Record<string, unknown>,
  statusOverrides: Record<string, number> = {},
) {
  return vi.fn(async (url: string | URL) => {
    const path = new URL(url).pathname;
    const body = responses[path];
    const status = statusOverrides[path] ?? (body !== undefined ? 200 : 404);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () =>
        body ?? { type: 'not-found', title: 'Not found', status, detail: 'no fixture' },
    } as Response;
  });
}

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.addCommand(createStatusCommand());
  return program;
}

describe('CLI status command', () => {
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

  it('prints project/automation state as JSON with --json', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/status': {
          project: { id: 'proj1', name: 'Test Project', state: 'active' },
          workflowState: { automation_state: 'running', active_feature_run_id: null, version: 3 },
          pendingOutboxCount: 0,
        },
        '/whoami': { id: 'test-operator', role: 'operator', actorKind: 'human' },
        '/triggerdev-runs': { items: [], nextCursor: null },
        '/commands/doctor': { healthy: true, checks: [] },
      }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync(['node', 'minicoder', 'status', '--project', 'proj1', '--json']);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"name": "Test Project"');
    expect(printed).toContain('"automation_state": "running"');
  });

  it('omits the state-health section on a 403 from /commands/doctor (viewer-role key)', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(
        {
          '/status': {
            project: { id: 'proj1', name: 'Test Project', state: 'active' },
            workflowState: { automation_state: 'running', active_feature_run_id: null, version: 1 },
            pendingOutboxCount: 0,
          },
          '/whoami': { id: 'test-viewer', role: 'viewer', actorKind: 'human' },
          '/triggerdev-runs': { items: [], nextCursor: null },
        },
        { '/commands/doctor': 403 },
      ),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync(['node', 'minicoder', 'status', '--project', 'proj1', '--json']);

    const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain('"name": "Test Project"');
    expect(printed).not.toContain('"doctor"');
  });

  it('requires --project', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(makeProgram().parseAsync(['node', 'minicoder', 'status'])).rejects.toThrow();
  });
});
