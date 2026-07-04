import type { CoderAgentAdapter, CoderInput, CoderOutput } from '@minicoder/core';
import { AdapterRunError } from '@minicoder/core';
import type { CodeGenerationProvider } from './code-generation-provider.js';
import type { DiffGuardOptions } from './diff-guard.js';
import { DiffGuardViolationError } from './diff-guard.js';
import { prepareBranch, commitAndPush, listRepoFiles } from './workspace.js';
import type { Sandbox } from './sandbox.js';

/** One tool-operation record the caller (`run-coder.ts`) folds into `AgentRunRecorder`'s
 * `toolOperationsExtractor` — see CLAUDE.md's Reference Coder Adapter Operational Constraints. */
export interface CodexToolOperation {
  readonly toolName: string;
  readonly status: 'success' | 'failure';
  readonly durationMs: number;
}

export interface CodexCoderOutput extends CoderOutput {
  readonly tokensUsed?: { readonly input: number; readonly output: number };
  readonly toolOperations: readonly CodexToolOperation[];
}

export interface CodexCoderAdapterOptions {
  readonly repoUrl: string;
  readonly githubToken: string;
  /** Working directory inside the sandbox container (or a local throwaway dir in tests).
   * Defaults to `/workspace` — the pre-baked sandbox image's writable scratch mount. */
  readonly workspaceDir?: string;
  readonly codeGenerationProvider: CodeGenerationProvider;
  readonly diffGuard?: DiffGuardOptions;
  /** Creates a fresh, not-yet-started sandbox for this run. One call per `run()` invocation —
   * one branch/workspace per run (docs/03 §11.1). */
  readonly createSandbox: () => Sandbox;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - start };
}

/**
 * Reference `CoderAgentAdapter` implementation (docs/06 Phase 9). Clone/list-files/write/test/
 * commit/push all run inside an ephemeral, egress-restricted sandbox container (docs/03 §11.1,
 * docs/07 §6), and the container is always torn down in a `finally` — success, failure, or a
 * thrown error. The code-generation call itself is deliberately host-side, not sandboxed (see the
 * call site below and docs/07 §6 "Phase 9 implementation status") — the sandbox is the untrusted-
 * code-execution boundary, so `CODE_GEN_API_KEY` must never be reachable from inside it. Never
 * merges (docs/03 §11.3). Never imports a provider SDK directly; `CodeGenerationProvider` is the
 * only external-call seam (docs/06 Phase 9 "Scope decisions" #1).
 */
export class CodexCoderAdapter implements CoderAgentAdapter {
  readonly role = 'CoderAgentAdapter' as const;

  constructor(private readonly options: CodexCoderAdapterOptions) {}

  async run(input: CoderInput): Promise<CodexCoderOutput> {
    const workspaceDir = this.options.workspaceDir ?? '/workspace';
    const sandbox = this.options.createSandbox();
    const toolOperations: CodexToolOperation[] = [];

    await sandbox.start();
    try {
      const {
        result: { repoDir },
      } = await this.timedOp(toolOperations, 'git-clone', () =>
        prepareBranch({
          workspaceDir,
          repoUrl: this.options.repoUrl,
          githubToken: this.options.githubToken,
          featureRunId: input.featureRunId,
          runner: sandbox,
          diffGuard: this.options.diffGuard,
        }),
      );

      // MEDIUM-2 code-review fix: include a bounded file listing so the provider has real
      // repository content to work from, not just the URL/branch name.
      const files = await listRepoFiles(sandbox, repoDir);
      const repoContext = [
        `Repository at ${this.options.repoUrl}, branch minicoder/${input.featureRunId}.`,
        files.length > 0
          ? `Tracked files:\n${files.join('\n')}`
          : 'Repository has no tracked files yet.',
      ].join('\n\n');
      // Deliberate trust-boundary split (docs/07 §6 "Phase 9 implementation status"): this call
      // runs in the host process, not inside `sandbox` — the code-generation credential
      // (CODE_GEN_API_KEY) must never be reachable from the same container that executes
      // LLM-generated code / project test scripts. Only clone/list-files/write/commit/push run
      // inside the sandbox; do not move this call into it without also removing the credential
      // from that container's reach.
      let generation;
      try {
        generation = await this.timedOp(toolOperations, 'code-generation', () =>
          this.options.codeGenerationProvider.generate({
            featureTitle: input.featureTitle,
            acceptanceCriteria: input.acceptanceCriteria,
            repoContext,
          }),
        );
      } catch (err) {
        throw new AdapterRunError(
          'provider_unavailable',
          `code generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let push;
      try {
        push = await this.timedOp(toolOperations, 'git-commit-push', () =>
          commitAndPush(
            {
              workspaceDir,
              repoUrl: this.options.repoUrl,
              githubToken: this.options.githubToken,
              featureRunId: input.featureRunId,
              runner: sandbox,
              diffGuard: this.options.diffGuard,
            },
            repoDir,
            generation.result.files,
            input.featureTitle,
          ),
        );
      } catch (err) {
        if (err instanceof DiffGuardViolationError) {
          throw new AdapterRunError('invalid_output', err.message);
        }
        throw err;
      }

      return {
        commitSha: push.result.commitSha,
        branchName: push.result.branchName,
        filesChanged: push.result.filesChanged,
        tokensUsed: generation.result.tokensUsed,
        toolOperations,
      };
    } finally {
      await sandbox.remove();
    }
  }

  private async timedOp<T>(
    ops: CodexToolOperation[],
    toolName: string,
    fn: () => Promise<T>,
  ): Promise<{ result: T; durationMs: number }> {
    try {
      const timing = await timed(fn);
      ops.push({ toolName, status: 'success', durationMs: timing.durationMs });
      return timing;
    } catch (err) {
      ops.push({ toolName, status: 'failure', durationMs: 0 });
      throw err;
    }
  }
}
