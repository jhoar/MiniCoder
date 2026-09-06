import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Command } from 'commander';

const mockListPullRequestsForBranch = vi.fn(async () => [] as Array<{ prNumber: number }>);
const mockResolveDefaultScmClient = vi.fn((_taskName: string) => async () => ({
  listPullRequestsForBranch: mockListPullRequestsForBranch,
}));

vi.mock('@minicoder/triggerdev', () => ({
  resolveDefaultScmClient: (taskName: string) => mockResolveDefaultScmClient(taskName),
}));

const mockEnsureRepositoryExists = vi.fn(
  async (
    _provider: string,
    _baseUrl: string | null,
    _owner: string,
    _name: string,
    defaultBranch: string,
  ) => ({ created: true, actualDefaultBranch: defaultBranch as string | null }),
);

vi.mock('./repo-create.js', () => ({
  ensureRepositoryExists: (...args: Parameters<typeof mockEnsureRepositoryExists>) =>
    mockEnsureRepositoryExists(...args),
}));

interface RepositoryRow {
  id: string;
  project_id: string;
  provider: string;
  owner: string;
  name: string;
  full_name: string;
  base_url: string | null;
  default_branch: string;
  version: number;
}

interface WorkflowEventRow {
  project_id: string;
  event_type: string;
  payload: string;
}

class FakeDb {
  projects = new Set<string>(['proj1']);
  repositories: RepositoryRow[] = [];
  workflowEvents: WorkflowEventRow[] = [];
  close = vi.fn(async () => {});

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql.includes('FROM projects')) {
      const id = params[0] as string;
      return (this.projects.has(id) ? [{ id }] : []) as unknown as T[];
    }
    if (sql.includes('FROM repositories')) {
      const projectId = params[0] as string;
      return this.repositories.filter((r) => r.project_id === projectId) as unknown as T[];
    }
    throw new Error(`FakeDb.query: unhandled SQL: ${sql}`);
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (sql.startsWith('INSERT INTO repositories')) {
      const [id, projectId, provider, baseUrl, owner, name, fullName, defaultBranch] = params as [
        string,
        string,
        string,
        string | null,
        string,
        string,
        string,
        string,
      ];
      this.repositories.push({
        id,
        project_id: projectId,
        provider,
        base_url: baseUrl,
        owner,
        name,
        full_name: fullName,
        default_branch: defaultBranch,
        version: 1,
      });
      return;
    }
    if (sql.startsWith('UPDATE repositories')) {
      const [provider, baseUrl, owner, name, fullName, defaultBranch, , id] = params as [
        string,
        string | null,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const row = this.repositories.find((r) => r.id === id);
      if (row) {
        row.provider = provider;
        row.base_url = baseUrl;
        row.owner = owner;
        row.name = name;
        row.full_name = fullName;
        row.default_branch = defaultBranch;
        row.version += 1;
      }
      return;
    }
    if (sql.startsWith('INSERT INTO workflow_events')) {
      // Params match the VALUES (?, NULL, ?, ?, NULL, NULL, ?, ?, '1.0.0', ?, ?) placeholders in
      // order: id, project_id, event_type, actor, payload, occurred_at, created_at.
      const [, projectId, eventType, , payload] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      this.workflowEvents.push({ project_id: projectId, event_type: eventType, payload });
      return;
    }
    throw new Error(`FakeDb.execute: unhandled SQL: ${sql}`);
  }

  async executeAffected(): Promise<number> {
    return 0;
  }

  async transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

let fakeDb: FakeDb;
const createDbClientFromEnvMock = vi.fn(async () => fakeDb);

vi.mock('../db-client.js', () => ({
  createDbClientFromEnv: () => createDbClientFromEnvMock(),
}));

async function loadCommand() {
  const { createRepoCommand } = await import('./repo.js');
  return createRepoCommand();
}

function makeProgram(command: Command): Command {
  const program = new Command().exitOverride();
  program.addCommand(command);
  return program;
}

describe('CLI repo command', () => {
  beforeEach(() => {
    fakeDb = new FakeDb();
    vi.clearAllMocks();
    mockListPullRequestsForBranch.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('rejects an unknown provider without touching the database', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'repo',
      'connect',
      '--project',
      'proj1',
      '--provider',
      'bitbucket',
      '--owner',
      'me',
      '--name',
      'repo1',
    ]);

    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/Unknown provider/);
    expect(createDbClientFromEnvMock).not.toHaveBeenCalled();
  });

  it('requires --base-url for a self-hosted provider', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'repo',
      'connect',
      '--project',
      'proj1',
      '--provider',
      'gitea',
      '--owner',
      'me',
      '--name',
      'repo1',
    ]);

    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/--base-url is required/);
    expect(createDbClientFromEnvMock).not.toHaveBeenCalled();
  });

  it('inserts a new repositories row and a repository.connected workflow_events audit row', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'repo',
      'connect',
      '--project',
      'proj1',
      '--provider',
      'gitea',
      '--owner',
      'minicoder',
      '--name',
      'demo',
      '--base-url',
      'http://localhost:3300',
      '--default-branch',
      'main',
      '--json',
    ]);

    expect(process.exitCode).toBe(0);
    expect(fakeDb.repositories).toHaveLength(1);
    expect(fakeDb.repositories[0]).toMatchObject({
      project_id: 'proj1',
      provider: 'gitea',
      full_name: 'minicoder/demo',
      base_url: 'http://localhost:3300',
      default_branch: 'main',
    });
    expect(fakeDb.workflowEvents).toHaveLength(1);
    expect(fakeDb.workflowEvents[0]!.event_type).toBe('repository.connected');
    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(printed.action).toBe('connected');
    expect(fakeDb.close).toHaveBeenCalled();
  });

  it('rejects a project already connected without --force', async () => {
    fakeDb.repositories.push({
      id: 'repo1',
      project_id: 'proj1',
      provider: 'github',
      owner: 'other',
      name: 'other-repo',
      full_name: 'other/other-repo',
      base_url: null,
      default_branch: 'main',
      version: 1,
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'repo',
      'connect',
      '--project',
      'proj1',
      '--provider',
      'gitea',
      '--owner',
      'minicoder',
      '--name',
      'demo',
      '--base-url',
      'http://localhost:3300',
    ]);

    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/already connected.*Pass --force/);
    expect(fakeDb.repositories).toHaveLength(1);
    expect(fakeDb.repositories[0]!.full_name).toBe('other/other-repo');
  });

  it('replaces the existing repositories row in place with --force', async () => {
    fakeDb.repositories.push({
      id: 'repo1',
      project_id: 'proj1',
      provider: 'github',
      owner: 'other',
      name: 'other-repo',
      full_name: 'other/other-repo',
      base_url: null,
      default_branch: 'main',
      version: 1,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'repo',
      'connect',
      '--project',
      'proj1',
      '--provider',
      'gitea',
      '--owner',
      'minicoder',
      '--name',
      'demo',
      '--base-url',
      'http://localhost:3300',
      '--force',
    ]);

    expect(process.exitCode).toBe(0);
    expect(fakeDb.repositories).toHaveLength(1);
    expect(fakeDb.repositories[0]).toMatchObject({
      id: 'repo1',
      provider: 'gitea',
      full_name: 'minicoder/demo',
      version: 2,
    });
    expect(fakeDb.workflowEvents[0]!.event_type).toBe('repository.reconnected');
  });

  it('rejects an unknown project', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'repo',
      'connect',
      '--project',
      'no-such-project',
      '--provider',
      'github',
      '--owner',
      'me',
      '--name',
      'repo1',
    ]);

    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/No project found/);
    expect(fakeDb.repositories).toHaveLength(0);
  });

  it('--verify calls the ScmClient reachability probe before writing, and aborts on failure', async () => {
    mockListPullRequestsForBranch.mockRejectedValueOnce(new Error('404 Not Found'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'repo',
      'connect',
      '--project',
      'proj1',
      '--provider',
      'gitea',
      '--owner',
      'minicoder',
      '--name',
      'demo',
      '--base-url',
      'http://localhost:3300',
      '--verify',
    ]);

    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/Could not reach minicoder\/demo/);
    expect(createDbClientFromEnvMock).not.toHaveBeenCalled();
    expect(mockResolveDefaultScmClient).toHaveBeenCalledWith('repo connect');
  });

  it('--create calls ensureRepositoryExists before writing and registers the repository', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'repo',
      'connect',
      '--project',
      'proj1',
      '--provider',
      'gitea',
      '--owner',
      'minicoder',
      '--name',
      'demo',
      '--base-url',
      'http://localhost:3300',
      '--create',
    ]);

    expect(process.exitCode).toBe(0);
    expect(mockEnsureRepositoryExists).toHaveBeenCalledWith(
      'gitea',
      'http://localhost:3300',
      'minicoder',
      'demo',
      'main',
    );
    expect(fakeDb.repositories).toHaveLength(1);
  });

  it('--create registers the SCM-reported actual default branch when it differs from the requested one', async () => {
    mockEnsureRepositoryExists.mockResolvedValueOnce({
      created: true,
      actualDefaultBranch: 'master',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'repo',
      'connect',
      '--project',
      'proj1',
      '--provider',
      'github',
      '--owner',
      'minicoder',
      '--name',
      'demo',
      '--create',
    ]);

    expect(process.exitCode).toBe(0);
    expect(fakeDb.repositories[0]!.default_branch).toBe('master');
  });

  it('--create aborts without writing when repository creation fails', async () => {
    mockEnsureRepositoryExists.mockRejectedValueOnce(
      new Error('Could not create minicoder/demo on Gitea'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync([
      'node',
      'minicoder',
      'repo',
      'connect',
      '--project',
      'proj1',
      '--provider',
      'gitea',
      '--owner',
      'minicoder',
      '--name',
      'demo',
      '--base-url',
      'http://localhost:3300',
      '--create',
    ]);

    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.join(' ')).toMatch(/Could not create minicoder\/demo/);
    expect(createDbClientFromEnvMock).not.toHaveBeenCalled();
  });

  it('repo show reports no connection for a project with no repositories row', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync(['node', 'minicoder', 'repo', 'show', '--project', 'proj1']);

    expect(logSpy.mock.calls.join(' ')).toMatch(/no connected repository/);
  });

  it('repo show prints the connected repository', async () => {
    fakeDb.repositories.push({
      id: 'repo1',
      project_id: 'proj1',
      provider: 'gitea',
      owner: 'minicoder',
      name: 'demo',
      full_name: 'minicoder/demo',
      base_url: 'http://localhost:3300',
      default_branch: 'main',
      version: 1,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = makeProgram(await loadCommand());

    await program.parseAsync(['node', 'minicoder', 'repo', 'show', '--project', 'proj1', '--json']);

    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(printed.repository.full_name).toBe('minicoder/demo');
  });
});
