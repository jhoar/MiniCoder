import { describe, it, expect } from 'vitest';
import { buildScmPullRequestUrl } from './scm-url.js';

describe('buildScmPullRequestUrl', () => {
  it('builds a github.com link with no baseUrl needed', () => {
    expect(buildScmPullRequestUrl('github', null, 'acme', 'widgets', 42)).toBe(
      'https://github.com/acme/widgets/pull/42',
    );
  });

  it('ignores a baseUrl for github even if one happens to be set', () => {
    expect(
      buildScmPullRequestUrl('github', 'https://ignored.example.test', 'acme', 'widgets', 42),
    ).toBe('https://github.com/acme/widgets/pull/42');
  });

  it('builds a Gitea link using the pulls/ path shape', () => {
    expect(
      buildScmPullRequestUrl('gitea', 'https://gitea.example.test', 'acme', 'widgets', 7),
    ).toBe('https://gitea.example.test/acme/widgets/pulls/7');
  });

  it('strips trailing slashes from a Gitea baseUrl', () => {
    expect(
      buildScmPullRequestUrl('gitea', 'https://gitea.example.test/', 'acme', 'widgets', 7),
    ).toBe('https://gitea.example.test/acme/widgets/pulls/7');
  });

  it('returns null for Gitea with no baseUrl recorded', () => {
    expect(buildScmPullRequestUrl('gitea', null, 'acme', 'widgets', 7)).toBeNull();
  });

  it('builds a GitLab link using the -/merge_requests/ path shape', () => {
    expect(
      buildScmPullRequestUrl('gitlab', 'https://gitlab.example.test', 'acme', 'widgets', 21),
    ).toBe('https://gitlab.example.test/acme/widgets/-/merge_requests/21');
  });

  it('returns null for GitLab with no baseUrl recorded', () => {
    expect(buildScmPullRequestUrl('gitlab', null, 'acme', 'widgets', 21)).toBeNull();
  });

  it('returns null for an unrecognized provider', () => {
    expect(
      buildScmPullRequestUrl('bitbucket', 'https://bitbucket.example.test', 'acme', 'widgets', 1),
    ).toBeNull();
  });
});
