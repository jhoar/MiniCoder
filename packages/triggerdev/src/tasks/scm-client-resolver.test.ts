import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OctokitGitHubClient } from '@minicoder/github';
import { GiteaScmClient } from '@minicoder/gitea';
import { GitlabScmClient } from '@minicoder/gitlab';
import { resolveDefaultScmClient } from './scm-client-resolver.js';

/**
 * Stage 6 write-pipeline fix (docs/06 §Phase 18): `resolveDefaultScmClient()` is the shared
 * resolver `github-reconciliation.ts`/`run-review.ts` now use instead of unconditionally
 * constructing `OctokitGitHubClient`. This tests the resolver directly, independent of either
 * task's own DB-seeded scenarios.
 */
describe('resolveDefaultScmClient', () => {
  const savedGithubToken = process.env['GITHUB_TOKEN'];
  const savedGiteaToken = process.env['GITEA_TOKEN'];
  const savedGitlabToken = process.env['GITLAB_TOKEN'];

  beforeEach(() => {
    process.env['GITHUB_TOKEN'] = 'test-github-token';
    process.env['GITEA_TOKEN'] = 'test-gitea-token';
    process.env['GITLAB_TOKEN'] = 'test-gitlab-token';
  });

  afterEach(() => {
    for (const [key, value] of [
      ['GITHUB_TOKEN', savedGithubToken],
      ['GITEA_TOKEN', savedGiteaToken],
      ['GITLAB_TOKEN', savedGitlabToken],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('resolves an OctokitGitHubClient for provider "github", ignoring baseUrl', async () => {
    const client = await resolveDefaultScmClient('test-task')('github', null);
    expect(client).toBeInstanceOf(OctokitGitHubClient);
  });

  it('resolves a GiteaScmClient for provider "gitea" given a baseUrl', async () => {
    const client = await resolveDefaultScmClient('test-task')(
      'gitea',
      'https://gitea.example.test',
    );
    expect(client).toBeInstanceOf(GiteaScmClient);
  });

  it('resolves a GitlabScmClient for provider "gitlab" given a baseUrl', async () => {
    const client = await resolveDefaultScmClient('test-task')(
      'gitlab',
      'https://gitlab.example.test',
    );
    expect(client).toBeInstanceOf(GitlabScmClient);
  });

  it('rejects a Gitea repository with no base_url recorded', async () => {
    await expect(resolveDefaultScmClient('test-task')('gitea', null)).rejects.toThrow(
      /no base_url recorded/,
    );
  });

  it('rejects a GitLab repository with no base_url recorded', async () => {
    await expect(resolveDefaultScmClient('test-task')('gitlab', null)).rejects.toThrow(
      /no base_url recorded/,
    );
  });

  it('rejects an unknown provider', async () => {
    await expect(resolveDefaultScmClient('test-task')('bitbucket', null)).rejects.toThrow(
      /unknown SCM provider "bitbucket"/,
    );
  });

  it.each(['', '   '])('rejects a whitespace-only GITHUB_TOKEN (%j)', async (blankValue) => {
    process.env['GITHUB_TOKEN'] = blankValue;
    await expect(resolveDefaultScmClient('test-task')('github', null)).rejects.toThrow(
      /GITHUB_TOKEN is not configured/,
    );
  });

  it.each(['', '   '])('rejects a whitespace-only GITEA_TOKEN (%j)', async (blankValue) => {
    process.env['GITEA_TOKEN'] = blankValue;
    await expect(
      resolveDefaultScmClient('test-task')('gitea', 'https://gitea.example.test'),
    ).rejects.toThrow(/GITEA_TOKEN is not configured/);
  });

  it.each(['', '   '])('rejects a whitespace-only GITLAB_TOKEN (%j)', async (blankValue) => {
    process.env['GITLAB_TOKEN'] = blankValue;
    await expect(
      resolveDefaultScmClient('test-task')('gitlab', 'https://gitlab.example.test'),
    ).rejects.toThrow(/GITLAB_TOKEN is not configured/);
  });

  it('interpolates the caller-supplied taskName into every thrown error message', async () => {
    await expect(resolveDefaultScmClient('my-task')('gitea', null)).rejects.toThrow(/my-task:/);
    await expect(resolveDefaultScmClient('my-task')('bitbucket', null)).rejects.toThrow(/my-task:/);
  });
});
