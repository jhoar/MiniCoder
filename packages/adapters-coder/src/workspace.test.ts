import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ChildProcessCommandRunner } from './command-runner.js';
import {
  prepareBranch,
  commitAndPush,
  branchNameFor,
  redactUrlCredentials,
  FEATURE_RUN_TRAILER,
} from './workspace.js';

const execFileAsync = promisify(execFile);

/**
 * These tests exercise the real git orchestration against a local, throwaway "remote" repo
 * (a bare repo on disk) — no Docker, no network. `ChildProcessCommandRunner` runs the exact same
 * code path `CoderSandbox` runs inside a container (see workspace.ts's runner-agnostic design).
 */
describe('workspace git orchestration (local, Docker-free)', () => {
  let tmpRoot: string;
  let bareRepoPath: string;
  let workspaceDir: string;
  const runner = new ChildProcessCommandRunner();

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'adapters-coder-test-'));
    bareRepoPath = path.join(tmpRoot, 'origin.git');
    workspaceDir = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });

    await execFileAsync('git', ['init', '--bare', '-b', 'main', bareRepoPath]);

    // Seed the bare repo with an initial commit on main via a throwaway working clone.
    const seedDir = path.join(tmpRoot, 'seed');
    await execFileAsync('git', ['clone', bareRepoPath, seedDir]);
    await fs.writeFile(path.join(seedDir, 'README.md'), '# seed\n', 'utf8');
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: seedDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: seedDir });
    await execFileAsync('git', ['add', '-A'], { cwd: seedDir });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: seedDir });
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: seedDir });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  // repoUrl must be a plain filesystem path for the local "remote"; authenticatedRemote()
  // rewrites it as a URL, so we pass a file:// URL to stay compatible with that helper.
  function repoFileUrl(): string {
    return `file://${bareRepoPath}`;
  }

  it('clones the repo and creates a new feature branch', async () => {
    const { repoDir } = await prepareBranch({
      workspaceDir,
      repoUrl: repoFileUrl(),
      gitToken: 'unused-for-file-remote',
      remoteUsername: 'x-access-token',
      featureRunId: 'fr-123',
      runner,
    });

    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoDir });
    expect(stdout.trim()).toBe(branchNameFor('fr-123'));
  });

  it('writes generated files, commits with the feature-run trailer, and pushes', async () => {
    const { repoDir } = await prepareBranch({
      workspaceDir,
      repoUrl: repoFileUrl(),
      gitToken: 'unused-for-file-remote',
      remoteUsername: 'x-access-token',
      featureRunId: 'fr-abc',
      runner,
    });

    const result = await commitAndPush(
      {
        workspaceDir,
        repoUrl: repoFileUrl(),
        gitToken: 'unused-for-file-remote',
        remoteUsername: 'x-access-token',
        featureRunId: 'fr-abc',
        runner,
      },
      repoDir,
      [{ path: 'src/widget.ts', content: 'export const widget = 1;\n' }],
      'Add widget',
    );

    expect(result.reusedExistingCommit).toBe(false);
    expect(result.filesChanged).toBe(1);
    expect(result.branchName).toBe('minicoder/fr-abc');

    const { stdout: log } = await execFileAsync('git', ['log', '-1', '--format=%B'], {
      cwd: repoDir,
    });
    expect(log).toContain(`${FEATURE_RUN_TRAILER}: fr-abc`);

    // Verify the push actually landed on the bare "remote".
    const { stdout: branches } = await execFileAsync('git', ['branch', '-r'], {
      cwd: path.join(tmpRoot, 'seed'),
    });
    // The seed clone doesn't know about the new branch yet; fetch to confirm it's really there.
    await execFileAsync('git', ['fetch', 'origin'], { cwd: path.join(tmpRoot, 'seed') });
    const { stdout: branchesAfterFetch } = await execFileAsync('git', ['branch', '-r'], {
      cwd: path.join(tmpRoot, 'seed'),
    });
    expect(branchesAfterFetch).toContain('minicoder/fr-abc');
    void branches;
  });

  it('is idempotent: a second call for the same feature run reuses the existing commit without re-pushing', async () => {
    const { repoDir } = await prepareBranch({
      workspaceDir,
      repoUrl: repoFileUrl(),
      gitToken: 'unused-for-file-remote',
      remoteUsername: 'x-access-token',
      featureRunId: 'fr-retry',
      runner,
    });
    const files = [{ path: 'src/widget.ts', content: 'export const widget = 1;\n' }];
    const first = await commitAndPush(
      {
        workspaceDir,
        repoUrl: repoFileUrl(),
        gitToken: 'unused-for-file-remote',
        remoteUsername: 'x-access-token',
        featureRunId: 'fr-retry',
        runner,
      },
      repoDir,
      files,
      'Add widget',
    );

    const second = await commitAndPush(
      {
        workspaceDir,
        repoUrl: repoFileUrl(),
        gitToken: 'unused-for-file-remote',
        remoteUsername: 'x-access-token',
        featureRunId: 'fr-retry',
        runner,
      },
      repoDir,
      files,
      'Add widget',
    );

    expect(second.reusedExistingCommit).toBe(true);
    expect(second.commitSha).toBe(first.commitSha);
  });

  it('rejects a diff that touches a disallowed path', async () => {
    const { repoDir } = await prepareBranch({
      workspaceDir,
      repoUrl: repoFileUrl(),
      gitToken: 'unused-for-file-remote',
      remoteUsername: 'x-access-token',
      featureRunId: 'fr-bad-path',
      runner,
    });

    await expect(
      commitAndPush(
        {
          workspaceDir,
          repoUrl: repoFileUrl(),
          gitToken: 'unused-for-file-remote',
          remoteUsername: 'x-access-token',
          featureRunId: 'fr-bad-path',
          runner,
        },
        repoDir,
        [{ path: '.github/workflows/evil.yml', content: 'oops' }],
        'Sneak in a workflow change',
      ),
    ).rejects.toThrow(/disallowed or unsafe path/);
  });

  it('never leaks the GitHub token in a failed-clone error message (HIGH-4 regression)', async () => {
    const secretToken = 'ghp_ThisTokenMustNeverAppearInAnErrorMessage123456';
    let thrown: unknown;
    try {
      await prepareBranch({
        workspaceDir,
        repoUrl: 'https://github-host-that-does-not-exist.invalid/acme/widgets.git',
        gitToken: secretToken,
        remoteUsername: 'x-access-token',
        featureRunId: 'fr-leak-check',
        runner,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(String(thrown)).not.toContain(secretToken);
  }, 20_000);
});

describe('redactUrlCredentials', () => {
  it('redacts userinfo from a URL embedded in arbitrary text', () => {
    const message =
      'git clone --depth 1 https://x-access-token:ghp_secret123@github.com/acme/widgets.git repo failed';
    expect(redactUrlCredentials(message)).toBe(
      'git clone --depth 1 https://***@github.com/acme/widgets.git repo failed',
    );
    expect(redactUrlCredentials(message)).not.toContain('ghp_secret123');
  });

  it('leaves text with no embedded credentials unchanged', () => {
    expect(redactUrlCredentials('plain error, no url here')).toBe('plain error, no url here');
  });
});
