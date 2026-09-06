import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';

interface RepositoryRow {
  project_id: string;
  provider: string;
  base_url: string | null;
}

class FakeDb {
  repositories: RepositoryRow[] = [];
  inboxEventCount = 0;
  close = vi.fn(async () => {});

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql.includes('FROM repositories')) {
      const projectId = params[0] as string;
      return this.repositories.filter((r) => r.project_id === projectId) as unknown as T[];
    }
    if (sql.includes('FROM inbox_events')) {
      return [{ count: this.inboxEventCount }] as unknown as T[];
    }
    throw new Error(`FakeDb.query: unhandled SQL: ${sql}`);
  }
}

let fakeDb: FakeDb;
const createDbClientFromEnvMock = vi.fn(async () => fakeDb);
vi.mock('../db-client.js', () => ({
  createDbClientFromEnv: () => createDbClientFromEnvMock(),
}));

const mockPollAndProcess = vi.fn(async () => ({ processed: 0, failed: 0 }));
const mockInboxProcessorCtor = vi.fn();
vi.mock('@minicoder/workflow', () => ({
  InboxProcessor: class {
    constructor(...args: unknown[]) {
      mockInboxProcessorCtor(...args);
    }
    pollAndProcess = mockPollAndProcess;
  },
}));

const mockScmClientResolver = vi.fn((_provider: string, _baseUrl: string | null) =>
  Promise.resolve({}),
);
const mockResolveDefaultScmClient = vi.fn((_taskName: string) => mockScmClientResolver);
vi.mock('@minicoder/triggerdev', () => ({
  resolveDefaultScmClient: (taskName: string) => mockResolveDefaultScmClient(taskName),
}));

const mockCreateGithubInboxHandlers = vi.fn(() => new Map());
vi.mock('@minicoder/github', () => ({
  createGithubInboxHandlers: (...args: Parameters<typeof mockCreateGithubInboxHandlers>) =>
    mockCreateGithubInboxHandlers(...args),
}));

const mockCreateGiteaInboxHandlers = vi.fn(() => new Map());
vi.mock('@minicoder/gitea', () => ({
  createGiteaInboxHandlers: (...args: Parameters<typeof mockCreateGiteaInboxHandlers>) =>
    mockCreateGiteaInboxHandlers(...args),
}));

const mockCreateGitlabInboxHandlers = vi.fn(() => new Map());
vi.mock('@minicoder/gitlab', () => ({
  createGitlabInboxHandlers: (...args: Parameters<typeof mockCreateGitlabInboxHandlers>) =>
    mockCreateGitlabInboxHandlers(...args),
}));

async function loadCommand() {
  const { createInboxCommand } = await import('./inbox.js');
  return createInboxCommand();
}

function makeProgram(command: Command): Command {
  const program = new Command().exitOverride();
  program.addCommand(command);
  return program;
}

describe('CLI inbox command', () => {
  beforeEach(() => {
    fakeDb = new FakeDb();
    vi.clearAllMocks();
    mockPollAndProcess.mockResolvedValue({ processed: 0, failed: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('rejects an unknown --provider without constructing a handler map', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync(['node', 'minicoder', 'inbox', 'drain', '--provider', 'bitbucket']);

    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/Unknown provider/);
    expect(mockCreateGithubInboxHandlers).not.toHaveBeenCalled();
  });

  it('requires --provider or --project', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync(['node', 'minicoder', 'inbox', 'drain']);

    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/Either --provider or --project/);
  });

  it('rejects --project with no connected repository', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync(['node', 'minicoder', 'inbox', 'drain', '--project', 'proj1']);

    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/No repository connected/);
  });

  it('resolves provider/base_url from the project repository row and builds gitea handlers', async () => {
    fakeDb.repositories.push({ project_id: 'ons', provider: 'gitea', base_url: 'http://x:3300' });
    fakeDb.inboxEventCount = 0;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync(['node', 'minicoder', 'inbox', 'drain', '--project', 'ons']);

    expect(mockCreateGiteaInboxHandlers).toHaveBeenCalledTimes(1);
    expect(mockCreateGithubInboxHandlers).not.toHaveBeenCalled();
    expect(mockInboxProcessorCtor).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.join(' ')).toMatch(/"status":"empty"|"status": "empty"/);
    expect(process.exitCode).toBe(0);
  });

  it('an explicit --provider skips the repositories lookup entirely', async () => {
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'inbox',
      'drain',
      '--provider',
      'github',
      '--base-url',
      'https://api.github.com',
    ]);

    expect(mockCreateGithubInboxHandlers).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  it('drain reports a timeout and a nonzero exit code when events never drain', async () => {
    fakeDb.inboxEventCount = 1;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'inbox',
      'drain',
      '--provider',
      'gitea',
      '--base-url',
      'http://x:3300',
      '--timeout-ms',
      '10',
      '--poll-interval-ms',
      '5',
    ]);

    expect(process.exitCode).toBe(1);
    expect(logSpy.mock.calls.join(' ')).toMatch(/"status":"timeout"|"status": "timeout"/);
    expect(errSpy.mock.calls.join(' ')).toMatch(/timed out/);
  });
});
