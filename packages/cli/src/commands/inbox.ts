/**
 * `minicoder inbox worker` / `minicoder inbox drain` — closes a real, critical gap found during
 * live end-to-end pipeline validation (issue #112): `minicoder github serve`/`gitea serve`/
 * `gitlab serve` (the real webhook receivers) and `minicoder {github,gitea,gitlab}
 * simulate-*` (the dev-tooling event simulators) both only ever INSERT a row into `inbox_events`
 * — nothing in this codebase's shipped CLI/API ever constructed an `InboxProcessor` and drained
 * it. `InboxProcessor` (`@minicoder/workflow`) was, before this command, exercised only by test
 * fixtures (`packages/testing/src/github-inbox-handlers.test.ts`,
 * `packages/workflow/src/inbox/processor.test.ts`). A real webhook delivery, or a simulated one,
 * would sit at `inbox_events.status = 'pending'` forever in any deployment shipped as of this
 * commit — directly contradicting decision #3's "SCM webhooks are the primary event source"
 * framing, since the primary path itself had no consumer.
 *
 * Mirrors `minicoder tasks worker`/`tasks drain`'s exact shape (`packages/cli/src/commands/
 * tasks.ts`) for the identical "long-running poll loop" vs. "one-shot CI/recovery drain" split —
 * this is the inbox-side counterpart to that task-queue-side pair, not a new pattern.
 *
 * `InboxHandler` lookup inside `InboxProcessor.pollAndProcess()` is keyed by bare `event_type`
 * with no `source` disambiguation (the normalized taxonomy — `pr.opened`/`check.passed`/etc. — is
 * deliberately identical across `@minicoder/github`/`@minicoder/gitea`/`@minicoder/gitlab`, per
 * each package's own inbox-handlers.ts doc comment), so this command builds exactly ONE provider's
 * handler map per process — matching the pre-existing, already-documented "one repository per
 * project" / "one SCM provider per deployment" assumption this codebase makes elsewhere (CLAUDE.md's
 * Merge Gate Operational Constraints). A deployment mixing providers across projects needs one
 * `inbox worker` process per provider; this is a real, documented scoping limit, not silently
 * assumed away.
 */
import { Command } from 'commander';
import { createDbClientFromEnv } from '../db-client.js';
import { InboxProcessor, type InboxHandler } from '@minicoder/workflow';
import { resolveDefaultScmClient } from '@minicoder/triggerdev';

const SUPPORTED_PROVIDERS = ['github', 'gitea', 'gitlab'] as const;
type Provider = (typeof SUPPORTED_PROVIDERS)[number];

function isSupportedProvider(value: string): value is Provider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

type Db = Awaited<ReturnType<typeof createDbClientFromEnv>>;

interface RepositoryProviderRow {
  provider: string;
  base_url: string | null;
}

interface InboxCommonOptions {
  provider?: string;
  project?: string;
  baseUrl?: string;
}

async function resolveProviderAndBaseUrl(
  db: Db,
  opts: InboxCommonOptions,
): Promise<{ provider: Provider; baseUrl: string | null }> {
  if (opts.provider) {
    if (!isSupportedProvider(opts.provider)) {
      throw new Error(
        `Unknown provider "${opts.provider}" — must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`,
      );
    }
    return { provider: opts.provider, baseUrl: opts.baseUrl?.trim() ? opts.baseUrl.trim() : null };
  }
  if (!opts.project) {
    throw new Error(
      "Either --provider or --project is required to resolve which SCM provider's inbox " +
        'handlers to build.',
    );
  }
  const rows = await db.query<RepositoryProviderRow>(
    `SELECT provider, base_url FROM repositories WHERE project_id = ?`,
    [opts.project],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      `No repository connected for project "${opts.project}" — pass --provider explicitly, or ` +
        'run "minicoder repo connect" first.',
    );
  }
  if (!isSupportedProvider(row.provider)) {
    throw new Error(
      `Unsupported provider "${row.provider}" recorded for project "${opts.project}".`,
    );
  }
  return {
    provider: row.provider,
    baseUrl: opts.baseUrl?.trim() ? opts.baseUrl.trim() : row.base_url,
  };
}

async function buildHandlers(
  db: Db,
  provider: Provider,
  baseUrl: string | null,
): Promise<Map<string, InboxHandler>> {
  const clientFactory = () => resolveDefaultScmClient('inbox worker')(provider, baseUrl);
  switch (provider) {
    case 'github': {
      const { createGithubInboxHandlers } = await import('@minicoder/github');
      return createGithubInboxHandlers(db, clientFactory);
    }
    case 'gitea': {
      const { createGiteaInboxHandlers } = await import('@minicoder/gitea');
      return createGiteaInboxHandlers(db, clientFactory);
    }
    case 'gitlab': {
      const { createGitlabInboxHandlers } = await import('@minicoder/gitlab');
      return createGitlabInboxHandlers(db, clientFactory);
    }
  }
}

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option(
      '--provider <provider>',
      `SCM provider (${SUPPORTED_PROVIDERS.join('|')}) — resolved from --project's ` +
        'repositories row if omitted',
    )
    .option(
      '--project <id>',
      'Project ID to resolve --provider/base-url from, when --provider is omitted',
    )
    .option(
      '--base-url <url>',
      'Override the base URL used to resolve the SCM client (self-hosted providers only)',
    );
}

export function createInboxCommand(): Command {
  const inbox = new Command('inbox').description(
    'Drains inbox_events (webhook-delivered and simulated SCM events) into real state ' +
      'transitions — see minicoder github/gitea/gitlab serve and simulate-* (issue #112)',
  );

  const worker = inbox
    .command('worker')
    .description('Poll inbox_events and process claimed events until terminated');
  addCommonOptions(worker)
    .option(
      '--poll-interval-ms <ms>',
      'Milliseconds between poll ticks',
      (v) => parseInt(v, 10),
      Number(process.env['INBOX_WORKER_POLL_INTERVAL_MS'] ?? '2000'),
    )
    .action(async (opts: InboxCommonOptions & { pollIntervalMs: number }) => {
      const db = await createDbClientFromEnv();
      let provider: Provider;
      let baseUrl: string | null;
      try {
        ({ provider, baseUrl } = await resolveProviderAndBaseUrl(db, opts));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        await db.close();
        return;
      }
      const handlers = await buildHandlers(db, provider, baseUrl);
      const processor = new InboxProcessor(db, handlers);

      let ticking = false;
      let shuttingDown = false;

      const tick = async (): Promise<void> => {
        if (ticking || shuttingDown) return;
        ticking = true;
        try {
          const { processed, failed } = await processor.pollAndProcess();
          if (processed > 0 || failed > 0) {
            console.log(
              JSON.stringify({
                event: 'poll',
                processed,
                failed,
                timestamp: new Date().toISOString(),
              }),
            );
          }
        } catch (err) {
          console.error('minicoder inbox worker: poll tick failed:', err);
        } finally {
          ticking = false;
        }
      };

      const interval = setInterval(() => void tick(), opts.pollIntervalMs);
      console.log(
        `minicoder inbox worker started (provider=${provider}, pollIntervalMs=${opts.pollIntervalMs})`,
      );

      const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`minicoder inbox worker: received ${signal}, finishing in-flight work...`);
        clearInterval(interval);
        while (ticking) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await db.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
    });

  const drain = inbox
    .command('drain')
    .description(
      'Poll inbox_events until empty or --timeout-ms elapses (CI/test/one-shot recovery use)',
    );
  addCommonOptions(drain)
    .option('--timeout-ms <ms>', 'Maximum time to wait', (v) => parseInt(v, 10), 60_000)
    .option(
      '--poll-interval-ms <ms>',
      'Milliseconds between poll ticks',
      (v) => parseInt(v, 10),
      500,
    )
    .action(async (opts: InboxCommonOptions & { timeoutMs: number; pollIntervalMs: number }) => {
      const db = await createDbClientFromEnv();
      try {
        const { provider, baseUrl } = await resolveProviderAndBaseUrl(db, opts);
        const handlers = await buildHandlers(db, provider, baseUrl);
        const processor = new InboxProcessor(db, handlers);
        const deadline = Date.now() + opts.timeoutMs;
        let totalProcessed = 0;
        let totalFailed = 0;

        while (Date.now() < deadline) {
          const { processed, failed } = await processor.pollAndProcess();
          totalProcessed += processed;
          totalFailed += failed;
          const remaining = await db.query<{ count: number }>(
            `SELECT COUNT(*) as count FROM inbox_events WHERE status IN ('pending', 'processing')`,
          );
          if (Number(remaining[0]?.count ?? 0) === 0) {
            console.log(
              JSON.stringify({
                command: 'inbox drain',
                status: 'empty',
                processed: totalProcessed,
                failed: totalFailed,
              }),
            );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
        }
        console.log(
          JSON.stringify({
            command: 'inbox drain',
            status: 'timeout',
            processed: totalProcessed,
            failed: totalFailed,
          }),
        );
        console.error(
          `minicoder inbox drain: timed out after ${opts.timeoutMs}ms with events remaining`,
        );
        process.exitCode = 1;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        await db.close();
      }
    });

  return inbox;
}
