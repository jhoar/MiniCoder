/**
 * Resolves a live `ScmClient` for one `(provider, baseUrl)` pair — the same shape
 * `packages/api/src/read-models/diagnostics.ts`'s `ScmClientResolver` and
 * `packages/cli/src/commands/state.ts`'s `resolveScmClientForDoctor()` already established for
 * `state doctor --check-scm` (docs/06 §Phase 18 Stage 5). This is the write-pipeline follow-up
 * flagged in that stage's completion notes: production write-path tasks (starting with
 * `github-reconciliation.ts`/`run-review.ts`) unconditionally constructed `OctokitGitHubClient`
 * regardless of a candidate repository's actual `repositories.provider`. This module is shared
 * (not copy-pasted per task, the way the pre-Stage-5 `GithubClientFactory` shape was duplicated
 * across five call sites) so `GITHUB_TOKEN`/`GITEA_TOKEN`/`GITLAB_TOKEN` resolution and error
 * messages stay identical across every task that adopts it.
 *
 * Only `github-reconciliation.ts` and `run-review.ts` use this so far — both are read-only
 * (fetch PR/MR state, never push code or execute a merge). `run-coder.ts`/`run-merge-gate.ts`/
 * `minicoder merge ...`/its API routes still use the older, GitHub-only `GithubClientFactory`
 * shape (`() => Promise<ScmClient>`, no provider argument) and were deliberately left unconverted
 * in this pass — they perform destructive/security-sensitive actions (pushing code, merging PRs)
 * that warrant their own, separately-reviewed follow-up rather than being folded into the same
 * change as the read-only paths. See docs/06 §Phase 18 Stage 6's completion notes for the full
 * list of remaining call sites.
 */
import type { ScmClient } from '@minicoder/core';
import { requireNonBlankEnvVar } from './env.js';

export type ScmClientResolver = (provider: string, baseUrl: string | null) => Promise<ScmClient>;

/**
 * Builds the default (non-injected) resolver. `taskName` is interpolated into every thrown
 * error message so an operator can tell which task's misconfigured credential is at fault
 * (mirrors `requireNonBlankEnvVar`'s own "actionable error" convention).
 */
export function resolveDefaultScmClient(taskName: string): ScmClientResolver {
  return async (provider: string, baseUrl: string | null): Promise<ScmClient> => {
    switch (provider) {
      case 'github': {
        const token = requireNonBlankEnvVar(
          'GITHUB_TOKEN',
          `${taskName} requires a GitHub credential (GitHub App installation token or PAT) to ` +
            'fetch authoritative PR state for a GitHub-provider repository — see ' +
            'docs/07-security-and-secrets.md §3.',
        );
        const { OctokitGitHubClient } = await import('@minicoder/github');
        return new OctokitGitHubClient({ auth: token });
      }
      case 'gitea': {
        const token = requireNonBlankEnvVar(
          'GITEA_TOKEN',
          `${taskName} requires a Gitea access token to fetch authoritative PR state for a ` +
            'Gitea-provider repository — see docs/07-security-and-secrets.md §3.2.',
        );
        if (!baseUrl) {
          throw new Error(
            `${taskName}: a Gitea-provider repository has no base_url recorded; cannot resolve ` +
              'which Gitea instance to query.',
          );
        }
        const { GiteaScmClient } = await import('@minicoder/gitea');
        return new GiteaScmClient({ baseUrl, token });
      }
      case 'gitlab': {
        const token = requireNonBlankEnvVar(
          'GITLAB_TOKEN',
          `${taskName} requires a GitLab access token to fetch authoritative PR state for a ` +
            'GitLab-provider repository — see docs/07-security-and-secrets.md §3.2.',
        );
        if (!baseUrl) {
          throw new Error(
            `${taskName}: a GitLab-provider repository has no base_url recorded; cannot resolve ` +
              'which GitLab instance to query.',
          );
        }
        const { GitlabScmClient } = await import('@minicoder/gitlab');
        return new GitlabScmClient({ baseUrl, token });
      }
      default:
        throw new Error(`${taskName}: unknown SCM provider "${provider}"`);
    }
  };
}
