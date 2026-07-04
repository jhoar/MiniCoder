import { execFile } from 'node:child_process';

/**
 * Thin seam over "run a command and capture output" so `workspace.ts`'s git orchestration is
 * testable without Docker (a `ChildProcessCommandRunner` for local dev/tests) and reusable inside
 * a running sandbox container (`sandbox.ts`'s `docker exec`-backed runner) without duplicating the
 * git-command logic.
 */
export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandRunner {
  run(
    cmd: string,
    args: readonly string[],
    opts?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
  ): Promise<CommandResult>;
}

/**
 * Runs commands via `child_process.execFile` — never `exec`/shell-string interpolation, so
 * feature titles/acceptance criteria flowing into argv can never be interpreted as shell syntax.
 */
export class ChildProcessCommandRunner implements CommandRunner {
  async run(
    cmd: string,
    args: readonly string[],
    opts: { cwd?: string; env?: Readonly<Record<string, string>> } = {},
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        cmd,
        args as string[],
        { cwd: opts.cwd, env: opts.env ? { ...process.env, ...opts.env } : process.env },
        (error, stdout, stderr) => {
          const exitCode = typeof error?.code === 'number' ? error.code : (error ? -1 : 0);
          if (error && typeof error.code !== 'number') {
            reject(error);
            return;
          }
          resolve({ stdout, stderr, exitCode });
        },
      );
    });
  }
}
