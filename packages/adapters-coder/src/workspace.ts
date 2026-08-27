import type { CommandRunner } from './command-runner.js';
import {
  assertDiffWithinBounds,
  validateRelativePath,
  DiffGuardViolationError,
  type ChangedFile,
  type DiffGuardOptions,
} from './diff-guard.js';
import type { GeneratedFile } from './code-generation-provider.js';

/** Trailer used to mark a commit as belonging to a specific feature run (docs/03 §11.6 —
 * idempotent retry: a re-invocation checks for this trailer at HEAD before re-committing). */
export const FEATURE_RUN_TRAILER = 'MiniCoder-Feature-Run';

export interface WorkspaceOptions {
  readonly workspaceDir: string;
  readonly repoUrl: string;
  readonly gitToken: string;
  /** HTTPS Basic-Auth username to pair with `gitToken` when embedding it into the clone/push
   * remote URL. The convention differs per SCM provider — GitHub's `x-access-token`, GitLab's
   * `oauth2`, Gitea's token-in-password-field flow — so this module stays provider-agnostic and
   * takes the caller's already-resolved choice rather than hardcoding one (docs/06 §Phase 18
   * Stage 6's coder-adapter-credential follow-up; `run-coder.ts`'s
   * `resolveDefaultCoderAdapterFactory()` is the real resolver). */
  readonly remoteUsername: string;
  readonly featureRunId: string;
  /** Runs every command (git, file writes) — either locally (`ChildProcessCommandRunner`) or
   * inside the sandbox container (`CoderSandbox`, via `docker exec`). Everything in this module
   * goes through this seam rather than the host `fs` module so the exact same orchestration code
   * runs identically in both places — the isolation boundary is "which runner is injected", not a
   * fork in this module's logic. */
  readonly runner: CommandRunner;
  readonly diffGuard?: DiffGuardOptions;
}

export interface PushResult {
  readonly commitSha: string;
  readonly branchName: string;
  readonly filesChanged: number;
  /** True if an existing commit for this feature run was found at HEAD and reused rather than
   * re-committed/re-pushed (idempotent retry — docs/03 §11.6). */
  readonly reusedExistingCommit: boolean;
}

function authenticatedRemote(repoUrl: string, remoteUsername: string, gitToken: string): string {
  const url = new URL(repoUrl);
  url.username = remoteUsername;
  url.password = gitToken;
  return url.toString();
}

/** Redacts userinfo (`user:token@`) from any URL embedded in `text` — HIGH-3 code-review fix:
 * `authenticatedRemote()` embeds the git token in the clone/push remote URL, and a failed git
 * command previously threw an error containing the full argv (and often echoed the URL again in
 * stderr), leaking the token into Trigger.dev logs/uncaught task errors. Applied to every error
 * this module throws, not just the clone/push call sites, since any git subcommand can be run
 * against a repo whose `origin` remote still carries the credential. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/:\/\/[^/\s@]+@/g, '://***@');
}

async function run(
  runner: CommandRunner,
  cwd: string,
  cmd: string,
  args: readonly string[],
): Promise<string> {
  const result = await runner.run(cmd, args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      redactUrlCredentials(
        `${cmd} ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr}`,
      ),
    );
  }
  return result.stdout.trim();
}

function git(runner: CommandRunner, cwd: string, args: readonly string[]): Promise<string> {
  return run(runner, cwd, 'git', args);
}

/** Writes `content` to `relativePath` (joined onto `cwd`) via the injected runner — a base64
 * argv payload decoded by a `sh -c` one-liner, so no stdin plumbing or host `fs` access is
 * required; the same call works whether `runner` executes locally or inside a container. */
async function writeFile(
  runner: CommandRunner,
  cwd: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const base64 = Buffer.from(content, 'utf8').toString('base64');
  const script = 'set -e; mkdir -p "$(dirname "$1")"; printf %s "$2" | base64 -d > "$1"';
  const result = await runner.run('sh', ['-c', script, '_', relativePath, base64], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`writing ${relativePath} failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

export function branchNameFor(featureRunId: string): string {
  return `minicoder/${featureRunId}`;
}

/** Clones the repo (shallow) and checks out (creating or reusing) the feature's branch. */
export async function prepareBranch(opts: WorkspaceOptions): Promise<{ repoDir: string }> {
  const repoDir = 'repo';
  const remote = authenticatedRemote(opts.repoUrl, opts.remoteUsername, opts.gitToken);
  const branch = branchNameFor(opts.featureRunId);

  await git(opts.runner, opts.workspaceDir, [
    'clone',
    '--depth',
    '1',
    '--no-single-branch',
    remote,
    repoDir,
  ]);

  const repoDirAbs = `${opts.workspaceDir}/${repoDir}`;

  // HIGH-2 code-review fix: the sandbox has no global git config, so `git commit` fails with
  // "Author identity unknown" without a repo-local identity. Set one unconditionally rather than
  // relying on an ambient global config that may or may not exist.
  await git(opts.runner, repoDirAbs, ['config', 'user.name', 'MiniCoder']);
  await git(opts.runner, repoDirAbs, ['config', 'user.email', 'coder-adapter@minicoder.invalid']);

  const remoteBranches = await git(opts.runner, repoDirAbs, ['branch', '-r']);
  if (remoteBranches.includes(`origin/${branch}`)) {
    await git(opts.runner, repoDirAbs, ['checkout', '-B', branch, `origin/${branch}`]);
  } else {
    await git(opts.runner, repoDirAbs, ['checkout', '-b', branch]);
  }

  return { repoDir: repoDirAbs };
}

const DEFAULT_MAX_CONTEXT_FILES = 200;

/** Lists tracked files in the clone (bounded), for assembling `CodeGenerationRequest.repoContext`
 * (MEDIUM-2 code-review fix: the provider previously received only the repo URL/branch name, not
 * any actual repository content — a bare file listing is a bounded, cheap-to-obtain improvement;
 * richer context — file excerpts, selection heuristics — is left as future work). */
export async function listRepoFiles(
  runner: CommandRunner,
  repoDir: string,
  maxFiles: number = DEFAULT_MAX_CONTEXT_FILES,
): Promise<readonly string[]> {
  const output = await git(runner, repoDir, ['ls-files']);
  if (!output) return [];
  return output.split('\n').filter(Boolean).slice(0, maxFiles);
}

/** Returns the CoderOutput of an existing commit for this feature run at HEAD, if one exists
 * (idempotent-retry check per docs/03 §11.6), without writing anything. */
export async function findExistingRunCommit(
  runner: CommandRunner,
  repoDir: string,
  featureRunId: string,
): Promise<{ commitSha: string } | null> {
  const log = await git(runner, repoDir, ['log', '-1', '--format=%H%n%B']);
  const [sha, ...bodyLines] = log.split('\n');
  const body = bodyLines.join('\n');
  if (sha && body.includes(`${FEATURE_RUN_TRAILER}: ${featureRunId}`)) {
    return { commitSha: sha };
  }
  return null;
}

/** Writes generated files, commits (trailer-tagged), and pushes — never `--force`. */
export async function commitAndPush(
  opts: WorkspaceOptions,
  repoDir: string,
  files: readonly GeneratedFile[],
  featureTitle: string,
): Promise<PushResult> {
  const branch = branchNameFor(opts.featureRunId);

  const existing = await findExistingRunCommit(opts.runner, repoDir, opts.featureRunId);
  if (existing) {
    return {
      commitSha: existing.commitSha,
      branchName: branch,
      filesChanged: files.length,
      reusedExistingCommit: true,
    };
  }

  // HIGH-3 code-review fix: validate every path *before* writing anything — a provider-generated
  // path like `../outside`, `/tmp/x`, or `foo/../.git/config` must never reach disk, not just be
  // flagged after the fact by assertDiffWithinBounds (which only runs once all writes are done).
  const changedFiles: ChangedFile[] = [];
  for (const file of files) {
    const safePath = validateRelativePath(file.path, opts.diffGuard?.disallowedPathPatterns);
    if (safePath === null) {
      throw new DiffGuardViolationError(`diff touches a disallowed or unsafe path: ${file.path}`);
    }
    await writeFile(opts.runner, repoDir, safePath, file.content);
    changedFiles.push({ path: safePath, bytesChanged: Buffer.byteLength(file.content, 'utf8') });
  }
  assertDiffWithinBounds(changedFiles, opts.diffGuard);

  await git(opts.runner, repoDir, ['add', '-A']);
  const commitMessage = `${opts.featureRunId}: ${featureTitle}\n\n${FEATURE_RUN_TRAILER}: ${opts.featureRunId}`;
  await git(opts.runner, repoDir, ['commit', '-m', commitMessage]);
  const commitSha = await git(opts.runner, repoDir, ['rev-parse', 'HEAD']);
  await git(opts.runner, repoDir, ['push', 'origin', `HEAD:${branch}`]);

  return {
    commitSha,
    branchName: branch,
    filesChanged: changedFiles.length,
    reusedExistingCommit: false,
  };
}
