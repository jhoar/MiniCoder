/**
 * Resolves a live `ScmClient` for one `(provider, baseUrl)` pair — the same shape
 * `packages/api/src/read-models/diagnostics.ts`'s `ScmClientResolver` and
 * `packages/cli/src/commands/state.ts`'s `resolveScmClientForDoctor()` already established for
 * `state doctor --check-scm` (docs/06 §Phase 18 Stage 5). This is the write-pipeline follow-up
 * flagged in that stage's completion notes: every production write-path caller used to
 * unconditionally construct `OctokitGitHubClient` regardless of a candidate repository's actual
 * `repositories.provider`. This module is shared (not copy-pasted per call site, the way the
 * pre-Stage-5 `GithubClientFactory` shape was duplicated five times) so
 * `GITHUB_TOKEN`/`GITEA_TOKEN`/`GITLAB_TOKEN` resolution and error messages stay identical
 * everywhere it's adopted.
 *
 * Adopted by `github-reconciliation.ts`, `run-review.ts` (reviewer diff fetch), `run-merge-gate.ts`
 * (status-check publication), `run-coder.ts` (the post-push `createPullRequest()` call only — see
 * below), `packages/cli/src/commands/merge.ts`, and its two API-route twins
 * (`merge-if-ready-route.ts`/`finalize-if-github-merged-route.ts`) — every production
 * `ScmClient`-consuming call site this codebase has, with one deliberate, documented exception:
 * `run-coder.ts`'s coder-adapter clone/push credential path (`resolveDefaultCoderAdapterFactory()`)
 * remains GitHub-only. That path embeds a token into the git remote URL under a hardcoded
 * `x-access-token` HTTPS Basic-Auth username (`workspace.ts`'s `authenticatedRemote()`) — GitHub's
 * own documented convention, but not GitLab's (`oauth2:<token>`) or Gitea's (`<username>:<token>`).
 * Generalizing it correctly requires deciding a per-provider username convention and verifying it
 * against a live Gitea/GitLab instance, which this environment cannot do (no reachable Docker
 * daemon — the same constraint documented for `infra/docker-compose.{gitea,gitlab}.yml`), so it
 * was left as real, tracked follow-up work rather than shipping an unverified guess. See
 * `run-coder.ts`'s `resolveDefaultCoderAdapterFactory()` doc comment and docs/06 §Phase 18 Stage
 * 6's completion notes for the full writeup.
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
