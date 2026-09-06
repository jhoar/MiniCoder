import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ensureRepositoryExists } from './repo-create.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('repo-create ensureRepositoryExists', () => {
  beforeEach(() => {
    process.env['GITEA_TOKEN'] = 'gitea-token';
    process.env['GITHUB_TOKEN'] = 'github-token';
    process.env['GITLAB_TOKEN'] = 'gitlab-token';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env['GITEA_TOKEN'];
    delete process.env['GITHUB_TOKEN'];
    delete process.env['GITLAB_TOKEN'];
  });

  it('gitea: reports created: false when the repository already exists', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === '/api/v1/repos/minicoder/demo') {
        return jsonResponse(200, { default_branch: 'main' });
      }
      throw new Error(`unexpected fetch to ${path}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await ensureRepositoryExists(
      'gitea',
      'http://localhost:3300',
      'minicoder',
      'demo',
      'main',
    );

    expect(result).toEqual({ created: false, initialized: false, actualDefaultBranch: 'main' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gitea: detects an empty pre-existing repository and initializes it with a seed commit', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/api/v1/repos/minicoder/demo') {
        return jsonResponse(200, { default_branch: 'main', empty: true });
      }
      if (path === '/api/v1/repos/minicoder/demo/contents/README.md') {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(init?.body as string);
        expect(body.branch).toBe('main');
        expect(body.message).toMatch(/Initial commit/);
        return jsonResponse(201, {});
      }
      throw new Error(`unexpected fetch to ${path}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await ensureRepositoryExists(
      'gitea',
      'http://localhost:3300',
      'minicoder',
      'demo',
      'main',
    );

    expect(result).toEqual({ created: false, initialized: true, actualDefaultBranch: 'main' });
  });

  it('gitea: surfaces a clear error when initializing an empty repository fails', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === '/api/v1/repos/minicoder/demo') {
        return jsonResponse(200, { default_branch: 'main', empty: true });
      }
      if (path === '/api/v1/repos/minicoder/demo/contents/README.md') {
        return jsonResponse(403, { message: 'insufficient permission' });
      }
      throw new Error(`unexpected fetch to ${path}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    await expect(
      ensureRepositoryExists('gitea', 'http://localhost:3300', 'minicoder', 'demo', 'main'),
    ).rejects.toThrow(/has no commits, and minicoder could not initialize it automatically/);
  });

  it('gitea: creates via the admin endpoint when the repository is missing', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/api/v1/repos/minicoder/demo') {
        return jsonResponse(404, {});
      }
      if (path === '/api/v1/admin/users/minicoder/repos') {
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>)['Authorization']).toBe(
          'token gitea-token',
        );
        return jsonResponse(201, { default_branch: 'main' });
      }
      throw new Error(`unexpected fetch to ${path}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await ensureRepositoryExists(
      'gitea',
      'http://localhost:3300',
      'minicoder',
      'demo',
      'main',
    );

    expect(result).toEqual({ created: true, initialized: false, actualDefaultBranch: 'main' });
  });

  it('gitea: falls back to /user/repos when the admin endpoint fails and owner matches the token user', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/api/v1/repos/minicoder/demo') return jsonResponse(404, {});
      if (path === '/api/v1/admin/users/minicoder/repos') return jsonResponse(403, {});
      if (path === '/api/v1/user') return jsonResponse(200, { login: 'minicoder' });
      if (path === '/api/v1/user/repos') {
        expect(init?.method).toBe('POST');
        return jsonResponse(201, { default_branch: 'main' });
      }
      throw new Error(`unexpected fetch to ${path}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await ensureRepositoryExists(
      'gitea',
      'http://localhost:3300',
      'minicoder',
      'demo',
      'main',
    );

    expect(result).toEqual({ created: true, initialized: false, actualDefaultBranch: 'main' });
  });

  it('gitea: throws a clear error when both the admin and fallback endpoints fail', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === '/api/v1/repos/minicoder/demo') return jsonResponse(404, {});
      if (path === '/api/v1/admin/users/minicoder/repos') return jsonResponse(403, {});
      if (path === '/api/v1/user') return jsonResponse(200, { login: 'someone-else' });
      if (path === '/api/v1/orgs/minicoder/repos') return jsonResponse(422, { message: 'nope' });
      throw new Error(`unexpected fetch to ${path}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    await expect(
      ensureRepositoryExists('gitea', 'http://localhost:3300', 'minicoder', 'demo', 'main'),
    ).rejects.toThrow(/Could not create minicoder\/demo on Gitea/);
  });

  it('github: creates under /user/repos when --owner matches the authenticated user', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/repos/minicoder/demo') return jsonResponse(404, {});
      if (path === '/user' && !init) throw new Error('expected headers on /user');
      if (path === '/user') return jsonResponse(200, { login: 'minicoder' });
      if (path === '/user/repos') {
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>)['Authorization']).toBe(
          'Bearer github-token',
        );
        return jsonResponse(201, { default_branch: 'main' });
      }
      throw new Error(`unexpected fetch to ${path}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await ensureRepositoryExists('github', null, 'minicoder', 'demo', 'main');

    expect(result).toEqual({ created: true, initialized: false, actualDefaultBranch: 'main' });
  });

  it('github: creates under /orgs/{owner}/repos when --owner differs from the authenticated user', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/repos/my-org/demo') return jsonResponse(404, {});
      if (path === '/user') return jsonResponse(200, { login: 'minicoder' });
      if (path === '/orgs/my-org/repos') {
        expect(init?.method).toBe('POST');
        return jsonResponse(201, { default_branch: 'main' });
      }
      throw new Error(`unexpected fetch to ${path}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await ensureRepositoryExists('github', null, 'my-org', 'demo', 'main');

    expect(result).toEqual({ created: true, initialized: false, actualDefaultBranch: 'main' });
  });

  it('github: reports the actual default branch when it differs from the request (GitHub cannot set it at creation)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === '/repos/minicoder/demo') return jsonResponse(404, {});
      if (path === '/user') return jsonResponse(200, { login: 'minicoder' });
      if (path === '/user/repos') return jsonResponse(201, { default_branch: 'master' });
      throw new Error(`unexpected fetch to ${path}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await ensureRepositoryExists('github', null, 'minicoder', 'demo', 'main');

    expect(result).toEqual({ created: true, initialized: false, actualDefaultBranch: 'master' });
    expect(errSpy.mock.calls.join(' ')).toMatch(/does not support setting the default branch/);
  });

  it('gitlab: creates under the token user namespace when --owner matches', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/api/v4/projects/minicoder%2Fdemo') return jsonResponse(404, {});
      if (path === '/api/v4/user') return jsonResponse(200, { username: 'minicoder' });
      if (path === '/api/v4/projects') {
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('gitlab-token');
        const body = JSON.parse(init?.body as string);
        expect(body.namespace_id).toBeUndefined();
        return jsonResponse(201, { default_branch: 'main' });
      }
      throw new Error(`unexpected fetch to ${path}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await ensureRepositoryExists(
      'gitlab',
      'http://localhost:3400',
      'minicoder',
      'demo',
      'main',
    );

    expect(result).toEqual({ created: true, initialized: false, actualDefaultBranch: 'main' });
  });

  it('gitlab: resolves a group namespace_id when --owner is not the token user', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/api/v4/projects/my-group%2Fdemo') return jsonResponse(404, {});
      if (path === '/api/v4/user') return jsonResponse(200, { username: 'minicoder' });
      if (path === '/api/v4/groups/my-group') return jsonResponse(200, { id: 42 });
      if (path === '/api/v4/projects') {
        const body = JSON.parse(init?.body as string);
        expect(body.namespace_id).toBe(42);
        return jsonResponse(201, { default_branch: 'main' });
      }
      throw new Error(`unexpected fetch to ${path}`);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await ensureRepositoryExists(
      'gitlab',
      'http://localhost:3400',
      'my-group',
      'demo',
      'main',
    );

    expect(result).toEqual({ created: true, initialized: false, actualDefaultBranch: 'main' });
  });

  it('requires --base-url for gitea/gitlab', async () => {
    await expect(
      ensureRepositoryExists('gitea', null, 'minicoder', 'demo', 'main'),
    ).rejects.toThrow(/requires --base-url/);
    await expect(
      ensureRepositoryExists('gitlab', null, 'minicoder', 'demo', 'main'),
    ).rejects.toThrow(/requires --base-url/);
  });

  it('throws an actionable error when the required token env var is blank', async () => {
    delete process.env['GITEA_TOKEN'];
    await expect(
      ensureRepositoryExists('gitea', 'http://localhost:3300', 'minicoder', 'demo', 'main'),
    ).rejects.toThrow(/GITEA_TOKEN/);
  });
});
