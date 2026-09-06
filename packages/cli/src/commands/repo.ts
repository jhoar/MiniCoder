/**
 * `minicoder repo connect` — closes the documented gap in CLAUDE.md's "Local Quickstart Defaults"
 * / USER-MANUAL.md §3.1.2: there was no CLI/API command to register a `repositories` row
 * (provider/base_url/owner/name) for a project, so every setup required a hand-written SQL INSERT.
 *
 * `repositories` carries no state-machine matrix (it is an observed/configuration table, not a
 * `CommandHandler`-governed one — the same category as `pull_requests`' observed mirror columns),
 * so this dispatches no `TransactionalCommandExecutor` command. It follows the established
 * "non-command DB write, CLI-only, audited via a workflow_events row" posture (`state repair`,
 * `design-doc repair-binding`) rather than inventing a new pattern — a one-off setup action has no
 * async/durable-retry need that would justify a Trigger.dev task or an API route.
 *
 * Every real write-path caller in this codebase assumes one repository per project
 * (`repositories WHERE project_id = ? LIMIT 1` — see CLAUDE.md's Merge Gate Operational
 * Constraints "one repository per project" note), so `connect` enforces that: a second `connect`
 * for a project already bound requires `--force` and updates the existing row in place rather than
 * inserting a second one.
 */
import { Command } from 'commander';
import { createDbClientFromEnv } from '../db-client.js';
import { generateId, isoNow } from '@minicoder/core';
import { resolveDefaultScmClient } from '@minicoder/triggerdev';

const SUPPORTED_PROVIDERS = ['github', 'gitea', 'gitlab'] as const;
type ScmProvider = (typeof SUPPORTED_PROVIDERS)[number];

function isSupportedProvider(value: string): value is ScmProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

interface RepositoryRow {
  id: string;
  provider: string;
  owner: string;
  name: string;
  full_name: string;
  base_url: string | null;
  default_branch: string;
  version: number;
}

interface ConnectOptions {
  project: string;
  provider: string;
  owner: string;
  name: string;
  baseUrl?: string;
  defaultBranch: string;
  force?: boolean;
  verify?: boolean;
  json?: boolean;
}

/** A harmless, never-real branch name used only to probe reachability/credentials — a repository
 * that exists returns an empty match list; one that doesn't (or a bad token) throws. */
const CONNECTIVITY_PROBE_BRANCH = '__minicoder-repo-connect-probe__';

async function verifyReachable(
  provider: ScmProvider,
  baseUrl: string | null,
  owner: string,
  name: string,
): Promise<void> {
  const resolver = resolveDefaultScmClient('repo connect');
  const client = await resolver(provider, baseUrl);
  try {
    await client.listPullRequestsForBranch(owner, name, CONNECTIVITY_PROBE_BRANCH, 'all');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach ${owner}/${name} on ${provider}${baseUrl ? ` (${baseUrl})` : ''} — ` +
        `check the repository exists and the configured credential/token is valid: ${message}`,
    );
  }
}

export function createRepoCommand(): Command {
  const repo = new Command('repo').description('Repository/SCM connection management');

  repo
    .command('connect')
    .description(
      'Register (or, with --force, replace) the repositories row a project uses for coder/' +
        'review/merge-gate/reconciliation SCM calls',
    )
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--provider <provider>', `SCM provider (${SUPPORTED_PROVIDERS.join('|')})`)
    .requiredOption('--owner <owner>', 'Repository owner/org/user, as it appears on the SCM')
    .requiredOption('--name <name>', 'Repository name, as it appears on the SCM')
    .option(
      '--base-url <url>',
      'Self-hosted instance base URL (required for gitea/gitlab; omit for github.com)',
    )
    .option('--default-branch <branch>', 'Default branch PRs are opened against', 'main')
    .option('--force', 'Replace an existing repositories row for this project instead of rejecting')
    .option(
      '--verify',
      'Confirm the repository is reachable with the configured credential before writing',
    )
    .option('--json', 'Print the result as JSON instead of a human-readable summary')
    .action(async (opts: ConnectOptions) => {
      if (!isSupportedProvider(opts.provider)) {
        console.error(
          `Unknown provider "${opts.provider}" — must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`,
        );
        process.exitCode = 1;
        return;
      }
      const provider: ScmProvider = opts.provider;

      if ((provider === 'gitea' || provider === 'gitlab') && !opts.baseUrl?.trim()) {
        console.error(
          `--base-url is required for a self-hosted "${provider}" repository (e.g. http://localhost:3300).`,
        );
        process.exitCode = 1;
        return;
      }
      const baseUrl = opts.baseUrl?.trim() ? opts.baseUrl.trim() : null;
      const fullName = `${opts.owner}/${opts.name}`;

      if (opts.verify) {
        try {
          await verifyReachable(provider, baseUrl, opts.owner, opts.name);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
          return;
        }
      }

      const db = await createDbClientFromEnv();
      try {
        const result = await db.transaction(async (tx) => {
          const projectRows = await tx.query<{ id: string }>(
            `SELECT id FROM projects WHERE id = ?`,
            [opts.project],
          );
          if (!projectRows[0]) {
            throw new Error(`No project found with id "${opts.project}"`);
          }

          const existingRows = await tx.query<RepositoryRow>(
            `SELECT id, provider, owner, name, full_name, base_url, default_branch, version
             FROM repositories WHERE project_id = ?`,
            [opts.project],
          );
          const existing = existingRows[0];
          const now = isoNow();

          if (existing && !opts.force) {
            throw new Error(
              `Project ${opts.project} is already connected to ${existing.full_name} ` +
                `(${existing.provider}). Pass --force to replace it.`,
            );
          }

          let repositoryId: string;
          let action: 'connected' | 'reconnected';
          if (existing) {
            repositoryId = existing.id;
            action = 'reconnected';
            await tx.execute(
              `UPDATE repositories
               SET provider = ?, base_url = ?, owner = ?, name = ?, full_name = ?,
                   default_branch = ?, version = version + 1, updated_at = ?
               WHERE id = ?`,
              [
                provider,
                baseUrl,
                opts.owner,
                opts.name,
                fullName,
                opts.defaultBranch,
                now,
                repositoryId,
              ],
            );
          } else {
            repositoryId = generateId();
            action = 'connected';
            await tx.execute(
              `INSERT INTO repositories
                 (id, project_id, provider, base_url, owner, name, full_name, default_branch,
                  version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
              [
                repositoryId,
                opts.project,
                provider,
                baseUrl,
                opts.owner,
                opts.name,
                fullName,
                opts.defaultBranch,
                now,
                now,
              ],
            );
          }

          await tx.execute(
            `INSERT INTO workflow_events
               (id, feature_run_id, project_id, event_type, from_state, to_state, actor, payload,
                payload_schema_version, occurred_at, created_at)
             VALUES (?, NULL, ?, ?, NULL, NULL, ?, ?, '1.0.0', ?, ?)`,
            [
              generateId(),
              opts.project,
              `repository.${action}`,
              'cli:repo-connect',
              JSON.stringify({
                repositoryId,
                provider,
                fullName,
                baseUrl,
                defaultBranch: opts.defaultBranch,
              }),
              now,
              now,
            ],
          );

          return {
            repositoryId,
            action,
            provider,
            fullName,
            baseUrl,
            defaultBranch: opts.defaultBranch,
          };
        });

        if (opts.json) {
          console.log(
            JSON.stringify(
              { command: 'repo connect', projectId: opts.project, ...result },
              null,
              2,
            ),
          );
        } else {
          console.log(
            `Project ${opts.project} ${result.action} to ${result.fullName} (${result.provider}` +
              `${result.baseUrl ? `, ${result.baseUrl}` : ''}), default branch "${result.defaultBranch}".`,
          );
          console.log(`repositories.id = ${result.repositoryId}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        await db.close();
      }
    });

  repo
    .command('show')
    .description('Show the repository currently connected to a project, if any')
    .requiredOption('--project <id>', 'Project ID')
    .option('--json', 'Print the result as JSON instead of a human-readable summary')
    .action(async (opts: { project: string; json?: boolean }) => {
      const db = await createDbClientFromEnv();
      try {
        const rows = await db.query<RepositoryRow>(
          `SELECT id, provider, owner, name, full_name, base_url, default_branch, version
           FROM repositories WHERE project_id = ?`,
          [opts.project],
        );
        const row = rows[0];
        if (opts.json) {
          console.log(
            JSON.stringify(
              { command: 'repo show', projectId: opts.project, repository: row ?? null },
              null,
              2,
            ),
          );
          return;
        }
        if (!row) {
          console.log(`Project ${opts.project} has no connected repository yet.`);
          return;
        }
        console.log(
          `${row.full_name} (${row.provider}${row.base_url ? `, ${row.base_url}` : ''}), ` +
            `default branch "${row.default_branch}", repositories.id = ${row.id}`,
        );
      } finally {
        await db.close();
      }
    });

  return repo;
}
