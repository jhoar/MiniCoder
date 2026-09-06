/**
 * `minicoder repo connect --create` — creates the repository on the SCM side (Gitea/GitHub/
 * GitLab) via a direct REST call if it doesn't already exist. Closes a real gap surfaced in
 * practice: `repo connect` alone only ever registered MiniCoder's own `repositories` row — it
 * never created anything on the SCM itself, so a fresh quickstart project (e.g. a brand-new
 * self-hosted Gitea instance with no repos yet) needed a separate manual `curl`/web-UI step
 * before `repo connect --verify` could succeed (its reachability probe 404s against a repo that
 * doesn't exist yet).
 *
 * Deliberately a plain-`fetch` helper local to the CLI, not a new method on the shared `ScmClient`
 * interface (`packages/core/src/scm/client.ts`) — repository creation is a one-off setup action,
 * not something any production write-path caller (`run-coder`, `run-review`, `run-merge-gate`,
 * `github-reconciliation`, `merge-if-ready`) needs, so it doesn't belong on the interface every
 * `ScmClient` implementation (`OctokitGitHubClient`, `GiteaScmClient`, `GitlabScmClient`,
 * `MockGitHubClient`) would then have to implement. Uses the same `GITHUB_TOKEN`/`GITEA_TOKEN`/
 * `GITLAB_TOKEN` env var convention `resolveDefaultScmClient()` already established.
 */
import { requireNonBlankEnvVar } from '@minicoder/triggerdev';

export type ScmProvider = 'github' | 'gitea' | 'gitlab';

const TOKEN_ENV_VAR: Record<ScmProvider, string> = {
  github: 'GITHUB_TOKEN',
  gitea: 'GITEA_TOKEN',
  gitlab: 'GITLAB_TOKEN',
};

function requireToken(provider: ScmProvider): string {
  return requireNonBlankEnvVar(
    TOKEN_ENV_VAR[provider],
    `repo connect --create requires ${TOKEN_ENV_VAR[provider]} to create a repository on ${provider}.`,
  );
}

export interface EnsureRepositoryResult {
  created: boolean;
  /** True when a pre-existing repository was found empty (zero commits — a real, reproduced
   * failure mode: an empty repo returns 200/`has_pull_requests: true` on a plain existence check,
   * but 404s on every PR-related route with Gitea's generic "target couldn't be found" message,
   * since those routes require at least one branch to exist) and was auto-initialized with a
   * seed commit so it's actually usable. Currently only detected/repaired for Gitea — GitHub's
   * and GitLab's create-repo calls always request `auto_init`/`initialize_with_readme`, so a repo
   * *this command created* is never left empty; an already-existing-but-empty GitHub/GitLab repo
   * (e.g. created manually with no README) is a real gap, just not yet reproduced/fixed here. */
  initialized: boolean;
  /** The default branch the SCM actually reports after creation/the existence check — may differ
   * from the caller's requested --default-branch. GitHub in particular does not accept a
   * default-branch override at creation time, so its account/org default (typically "main")
   * always wins there. */
  actualDefaultBranch: string | null;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

async function fetchJson(url: string, init: RequestInit): Promise<JsonResponse> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function stringField(body: unknown, field: string): string | null {
  if (body && typeof body === 'object' && field in body) {
    const value = (body as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function numberField(body: unknown, field: string): number | null {
  if (body && typeof body === 'object' && field in body) {
    const value = (body as Record<string, unknown>)[field];
    return typeof value === 'number' ? value : null;
  }
  return null;
}

function booleanField(body: unknown, field: string): boolean | null {
  if (body && typeof body === 'object' && field in body) {
    const value = (body as Record<string, unknown>)[field];
    return typeof value === 'boolean' ? value : null;
  }
  return null;
}

/** Seeds a README commit on `branch` via Gitea's "create file" API — the same recovery an
 * operator would otherwise have to run by hand. Mirrors the `auto_init: true` a fresh `--create`
 * would have requested; this is the repair path for a repo that already existed but had no
 * commits at all. */
async function initializeEmptyGiteaRepository(
  baseUrl: string,
  headers: Record<string, string>,
  owner: string,
  name: string,
  branch: string,
): Promise<void> {
  const content = Buffer.from(`# ${name}\n`, 'utf-8').toString('base64');
  const created = await fetchJson(`${baseUrl}/api/v1/repos/${owner}/${name}/contents/README.md`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message: 'Initial commit (minicoder repo connect --create)',
      content,
      branch,
    }),
  });
  if (created.status !== 201) {
    throw new Error(
      `${owner}/${name} exists on Gitea but has no commits, and minicoder could not initialize ` +
        `it automatically (status ${created.status}): ${JSON.stringify(created.body)}`,
    );
  }
}

async function ensureGiteaRepository(
  baseUrl: string,
  owner: string,
  name: string,
  defaultBranch: string,
): Promise<EnsureRepositoryResult> {
  const token = requireToken('gitea');
  const headers = { Authorization: `token ${token}`, 'Content-Type': 'application/json' };

  const existing = await fetchJson(`${baseUrl}/api/v1/repos/${owner}/${name}`, { headers });
  if (existing.status === 200) {
    if (booleanField(existing.body, 'empty') === true) {
      await initializeEmptyGiteaRepository(baseUrl, headers, owner, name, defaultBranch);
      return { created: false, initialized: true, actualDefaultBranch: defaultBranch };
    }
    return {
      created: false,
      initialized: false,
      actualDefaultBranch: stringField(existing.body, 'default_branch'),
    };
  }
  if (existing.status !== 404) {
    throw new Error(`Gitea GET /repos/${owner}/${name} failed with status ${existing.status}`);
  }

  const body = JSON.stringify({
    name,
    private: false,
    auto_init: true,
    default_branch: defaultBranch,
  });

  // Prefer the admin endpoint — it works regardless of whether `owner` is the token's own user or
  // a different one, as long as the token belongs to a Gitea admin (true for the quickstart
  // bootstrap's `minicoder` admin user). Falls back to the plain user/org endpoints for a
  // non-admin token.
  const adminCreate = await fetchJson(`${baseUrl}/api/v1/admin/users/${owner}/repos`, {
    method: 'POST',
    headers,
    body,
  });
  if (adminCreate.status === 201) {
    return {
      created: true,
      initialized: false,
      actualDefaultBranch: stringField(adminCreate.body, 'default_branch') ?? defaultBranch,
    };
  }

  const me = await fetchJson(`${baseUrl}/api/v1/user`, { headers });
  const isOwnUser = me.status === 200 && stringField(me.body, 'login') === owner;
  const fallbackUrl = isOwnUser
    ? `${baseUrl}/api/v1/user/repos`
    : `${baseUrl}/api/v1/orgs/${owner}/repos`;
  const fallbackCreate = await fetchJson(fallbackUrl, { method: 'POST', headers, body });
  if (fallbackCreate.status === 201) {
    return {
      created: true,
      initialized: false,
      actualDefaultBranch: stringField(fallbackCreate.body, 'default_branch') ?? defaultBranch,
    };
  }
  throw new Error(
    `Could not create ${owner}/${name} on Gitea: admin endpoint returned ${adminCreate.status}, ` +
      `fallback (${fallbackUrl}) returned ${fallbackCreate.status}. Response: ` +
      `${JSON.stringify(fallbackCreate.body)}`,
  );
}

async function ensureGithubRepository(
  owner: string,
  name: string,
  defaultBranch: string,
): Promise<EnsureRepositoryResult> {
  const token = requireToken('github');
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
  };
  const apiBase = 'https://api.github.com';

  const existing = await fetchJson(`${apiBase}/repos/${owner}/${name}`, { headers });
  if (existing.status === 200) {
    return {
      created: false,
      initialized: false,
      actualDefaultBranch: stringField(existing.body, 'default_branch'),
    };
  }
  if (existing.status !== 404) {
    throw new Error(`GitHub GET /repos/${owner}/${name} failed with status ${existing.status}`);
  }

  const me = await fetchJson(`${apiBase}/user`, { headers });
  if (me.status !== 200) {
    throw new Error(`GitHub GET /user failed with status ${me.status} — check GITHUB_TOKEN`);
  }
  const isOwnUser = stringField(me.body, 'login') === owner;
  const createUrl = isOwnUser ? `${apiBase}/user/repos` : `${apiBase}/orgs/${owner}/repos`;
  const created = await fetchJson(createUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, private: false, auto_init: true }),
  });
  if (created.status !== 201) {
    throw new Error(
      `Could not create ${owner}/${name} on GitHub (${createUrl} returned ${created.status}): ` +
        `${JSON.stringify(created.body)}`,
    );
  }
  const actualDefaultBranch = stringField(created.body, 'default_branch');
  if (actualDefaultBranch && actualDefaultBranch !== defaultBranch) {
    console.error(
      `Note: GitHub created ${owner}/${name} with default branch "${actualDefaultBranch}", ` +
        `not the requested "${defaultBranch}" — GitHub does not support setting the default ` +
        `branch at creation time. Registering the repository with "${actualDefaultBranch}" instead.`,
    );
  }
  return { created: true, initialized: false, actualDefaultBranch };
}

async function ensureGitlabRepository(
  baseUrl: string,
  owner: string,
  name: string,
  defaultBranch: string,
): Promise<EnsureRepositoryResult> {
  const token = requireToken('gitlab');
  const headers = { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' };
  const apiBase = `${baseUrl}/api/v4`;
  const encodedPath = encodeURIComponent(`${owner}/${name}`);

  const existing = await fetchJson(`${apiBase}/projects/${encodedPath}`, { headers });
  if (existing.status === 200) {
    return {
      created: false,
      initialized: false,
      actualDefaultBranch: stringField(existing.body, 'default_branch'),
    };
  }
  if (existing.status !== 404) {
    throw new Error(
      `GitLab GET /projects/${owner}%2F${name} failed with status ${existing.status}`,
    );
  }

  const me = await fetchJson(`${apiBase}/user`, { headers });
  if (me.status !== 200) {
    throw new Error(`GitLab GET /user failed with status ${me.status} — check GITLAB_TOKEN`);
  }
  const isOwnUser = stringField(me.body, 'username') === owner;

  let namespaceId: number | undefined;
  if (!isOwnUser) {
    const group = await fetchJson(`${apiBase}/groups/${encodeURIComponent(owner)}`, { headers });
    if (group.status !== 200) {
      throw new Error(
        `Could not resolve GitLab namespace "${owner}" as a group (status ${group.status}) — ` +
          `for a group-owned project, --owner must name an existing GitLab group.`,
      );
    }
    namespaceId = numberField(group.body, 'id') ?? undefined;
  }

  const created = await fetchJson(`${apiBase}/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name,
      path: name,
      default_branch: defaultBranch,
      initialize_with_readme: true,
      ...(namespaceId ? { namespace_id: namespaceId } : {}),
    }),
  });
  if (created.status !== 201) {
    throw new Error(
      `Could not create ${owner}/${name} on GitLab (status ${created.status}): ` +
        `${JSON.stringify(created.body)}`,
    );
  }
  return {
    created: true,
    initialized: false,
    actualDefaultBranch: stringField(created.body, 'default_branch') ?? defaultBranch,
  };
}

/** Creates `owner/name` on `provider` if it doesn't already exist; a no-op (`created: false`) if
 * it does. Idempotent — safe to call on every `repo connect --create` invocation. */
export async function ensureRepositoryExists(
  provider: ScmProvider,
  baseUrl: string | null,
  owner: string,
  name: string,
  defaultBranch: string,
): Promise<EnsureRepositoryResult> {
  switch (provider) {
    case 'gitea':
      if (!baseUrl) throw new Error('A Gitea repository requires --base-url to create it.');
      return ensureGiteaRepository(baseUrl, owner, name, defaultBranch);
    case 'github':
      return ensureGithubRepository(owner, name, defaultBranch);
    case 'gitlab':
      if (!baseUrl) throw new Error('A GitLab repository requires --base-url to create it.');
      return ensureGitlabRepository(baseUrl, owner, name, defaultBranch);
  }
}
