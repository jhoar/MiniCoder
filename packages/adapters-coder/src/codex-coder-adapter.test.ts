import { describe, it, expect } from 'vitest';
import { AdapterRunError } from '@minicoder/core';
import { CodexCoderAdapter } from './codex-coder-adapter.js';
import type { Sandbox } from './sandbox.js';
import type { CommandResult } from './command-runner.js';
import type { CodeGenerationProvider } from './code-generation-provider.js';

/** Fake sandbox implementing just enough of `git`/`sh` behavior in-memory to drive the adapter
 * without Docker or a real git binary — the git/file-write orchestration itself is already
 * covered against a real git repo in workspace.test.ts. */
function fakeSandbox(opts: { existingCommitTrailer?: string } = {}): {
  sandbox: Sandbox;
  started: boolean[];
  removed: boolean[];
  pushed: boolean;
} {
  const started: boolean[] = [];
  const removed: boolean[] = [];
  let pushed = false;
  const headSha = 'abc123';
  const commitLog = opts.existingCommitTrailer
    ? `existing-sha\n\n${opts.existingCommitTrailer}`
    : '';

  const sandbox: Sandbox = {
    start: async () => {
      started.push(true);
    },
    remove: async () => {
      removed.push(true);
    },
    run: async (cmd, args): Promise<CommandResult> => {
      const joined = args.join(' ');
      if (cmd === 'git' && joined.startsWith('clone')) return ok('');
      if (cmd === 'git' && joined.startsWith('branch -r')) return ok('');
      if (cmd === 'git' && (joined.startsWith('checkout -b') || joined.startsWith('checkout -B')))
        return ok('');
      if (cmd === 'git' && joined.startsWith('log -1')) return ok(commitLog);
      if (cmd === 'git' && joined.startsWith('ls-files')) return ok('README.md\nsrc/index.ts\n');
      if (cmd === 'sh') return ok(''); // writeFile
      if (cmd === 'git' && joined.startsWith('add')) return ok('');
      if (cmd === 'git' && joined.startsWith('commit')) return ok('');
      if (cmd === 'git' && joined.startsWith('rev-parse')) return ok(headSha);
      if (cmd === 'git' && joined.startsWith('push')) {
        pushed = true;
        return ok('');
      }
      return ok('');
    },
  };
  return {
    sandbox,
    started,
    removed,
    get pushed() {
      return pushed;
    },
  };

  function ok(stdout: string): CommandResult {
    return { stdout, stderr: '', exitCode: 0 };
  }
}

const workingProvider: CodeGenerationProvider = {
  generate: async () => ({
    files: [{ path: 'src/widget.ts', content: 'export const widget = 1;\n' }],
    tokensUsed: { input: 10, output: 5 },
  }),
};

function recordingProvider(): CodeGenerationProvider & {
  requests: Array<{ repoContext: string }>;
} {
  const requests: Array<{ repoContext: string }> = [];
  return {
    requests,
    generate: async (request) => {
      requests.push({ repoContext: request.repoContext });
      return {
        files: [{ path: 'src/widget.ts', content: 'export const widget = 1;\n' }],
        tokensUsed: { input: 10, output: 5 },
      };
    },
  };
}

describe('CodexCoderAdapter', () => {
  it('produces a CoderOutput and always starts/removes the sandbox', async () => {
    const { sandbox, started, removed } = fakeSandbox();
    const adapter = new CodexCoderAdapter({
      repoUrl: 'https://github.com/acme/repo.git',
      githubToken: 'tok',
      codeGenerationProvider: workingProvider,
      createSandbox: () => sandbox,
    });

    const output = await adapter.run({
      projectId: 'proj-1',
      featureRunId: 'fr-1',
      featureTitle: 'Add widget',
      acceptanceCriteria: ['does a thing'],
      correlationId: 'corr-1',
    });

    expect(output.commitSha).toBeTruthy();
    expect(output.branchName).toBe('minicoder/fr-1');
    expect(output.filesChanged).toBe(1);
    expect(output.tokensUsed).toEqual({ input: 10, output: 5 });
    expect(output.toolOperations.map((o) => o.toolName)).toEqual([
      'git-clone',
      'code-generation',
      'git-commit-push',
    ]);
    expect(output.toolOperations.every((o) => o.status === 'success')).toBe(true);
    expect(started).toEqual([true]);
    expect(removed).toEqual([true]);
  });

  it('passes a bounded repo file listing to the code-generation provider (MEDIUM-2 regression)', async () => {
    const { sandbox } = fakeSandbox();
    const provider = recordingProvider();
    const adapter = new CodexCoderAdapter({
      repoUrl: 'https://github.com/acme/repo.git',
      githubToken: 'tok',
      codeGenerationProvider: provider,
      createSandbox: () => sandbox,
    });

    await adapter.run({
      projectId: 'proj-1',
      featureRunId: 'fr-context',
      featureTitle: 'Add widget',
      acceptanceCriteria: [],
      correlationId: 'corr-context',
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.repoContext).toContain('README.md');
    expect(provider.requests[0]?.repoContext).toContain('src/index.ts');
  });

  it('removes the sandbox even when code generation fails, and maps the error to provider_unavailable', async () => {
    const { sandbox, removed } = fakeSandbox();
    const failingProvider: CodeGenerationProvider = {
      generate: async () => {
        throw new Error('rate limited');
      },
    };
    const adapter = new CodexCoderAdapter({
      repoUrl: 'https://github.com/acme/repo.git',
      githubToken: 'tok',
      codeGenerationProvider: failingProvider,
      createSandbox: () => sandbox,
    });

    await expect(
      adapter.run({
        projectId: 'proj-1',
        featureRunId: 'fr-2',
        featureTitle: 'Add widget',
        acceptanceCriteria: [],
        correlationId: 'corr-2',
      }),
    ).rejects.toMatchObject({
      errorType: 'provider_unavailable',
    } satisfies Partial<AdapterRunError>);

    expect(removed).toEqual([true]);
  });

  it('is idempotent: reuses an existing commit for the same feature run without re-pushing', async () => {
    const { sandbox } = fakeSandbox({ existingCommitTrailer: 'MiniCoder-Feature-Run: fr-3' });
    const adapter = new CodexCoderAdapter({
      repoUrl: 'https://github.com/acme/repo.git',
      githubToken: 'tok',
      codeGenerationProvider: workingProvider,
      createSandbox: () => sandbox,
    });

    const output = await adapter.run({
      projectId: 'proj-1',
      featureRunId: 'fr-3',
      featureTitle: 'Add widget',
      acceptanceCriteria: [],
      correlationId: 'corr-3',
    });

    expect(output.commitSha).toBe('existing-sha');
  });

  it('starts a fresh sandbox per run() call', async () => {
    const first = fakeSandbox();
    const second = fakeSandbox();
    const sandboxes = [first.sandbox, second.sandbox];
    const adapter = new CodexCoderAdapter({
      repoUrl: 'https://github.com/acme/repo.git',
      githubToken: 'tok',
      codeGenerationProvider: workingProvider,
      createSandbox: () => sandboxes.shift() as Sandbox,
    });

    await adapter.run({
      projectId: 'p',
      featureRunId: 'fr-a',
      featureTitle: 't',
      acceptanceCriteria: [],
      correlationId: 'c',
    });
    await adapter.run({
      projectId: 'p',
      featureRunId: 'fr-b',
      featureTitle: 't',
      acceptanceCriteria: [],
      correlationId: 'c',
    });

    expect(first.started).toEqual([true]);
    expect(first.removed).toEqual([true]);
    expect(second.started).toEqual([true]);
    expect(second.removed).toEqual([true]);
  });
});
