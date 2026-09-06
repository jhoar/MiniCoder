/**
 * `minicoder gitlab ...` — mirrors `minicoder github ...`/`minicoder gitea ...` (`./github.ts`/
 * `./gitea.ts`), adjusted for GitLab's wire format (docs/06 §Phase 18 Stage 4). Its own top-level
 * command group, the same "each SCM provider gets its own named surface" pattern already
 * established for the other two providers.
 *
 * `simulate-review-changes-requested` and `simulate-branch-protection-ok` are both deliberately
 * absent here — not an oversight. GitLab has no webhook event corresponding to a discrete
 * "reviewer requested changes" action (see `@minicoder/gitlab`'s `normalize.ts` doc comment), and
 * no inbox handler is registered for `review.changes_requested` on this provider either
 * (`@minicoder/gitlab`'s `inbox-handlers.ts`) — a simulate command for it would insert an
 * `inbox_events` row nothing ever processes, misrepresenting a structurally-impossible real event
 * as a realistic one to simulate. `simulate-branch-protection-ok` has no real webhook behind it
 * even on the GitHub side it originated from.
 */
import { Command } from 'commander';
import { createDbClientFromEnv } from '../db-client.js';
import { createGitlabWebhookApp } from '@minicoder/gitlab';
import { SCHEMA_VERSION } from '@minicoder/core';

const ALLOWED_ENVS = new Set(['development', 'test', 'ci']);

function guardEnv(): void {
  if (process.env['APP_ENV'] === 'production' || process.env['NODE_ENV'] === 'production') {
    console.error(
      'Error: minicoder gitlab commands are not permitted when APP_ENV or NODE_ENV is production.',
    );
    process.exit(1);
  }
  const env = process.env['APP_ENV'] ?? process.env['NODE_ENV'] ?? 'production';
  if (!ALLOWED_ENVS.has(env)) {
    console.error(
      `Error: minicoder gitlab commands are only available in development/test/ci environments.\n` +
        `Current APP_ENV/NODE_ENV: '${env}'. Set APP_ENV=development to use this command.`,
    );
    process.exit(1);
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

type DbClient = Awaited<ReturnType<typeof createDbClientFromEnv>>;

/**
 * Issue #113: every call site below built `dedupKey` from only `project`/`prNumber`/etc — with
 * no per-invocation discriminator — while `id` always included `Date.now()`. A second simulate-*
 * call for the same PR/check-name/reviewer (the exact "let me re-trigger reconciliation" workflow
 * this dev tooling exists for) hit `inbox_events.dedup_key`'s UNIQUE constraint and crashed the
 * whole CLI process with a raw, uncaught SqliteError stack trace instead of a clean error.
 * Unlike the real webhook receiver (`webhook-app.ts`), where `dedup_key` is the actual delivery
 * GUID and must dedupe retried deliveries, a simulate-* dedup_key serves no real purpose — there
 * is no "real delivery" to dedupe. Fixed by folding `id` (already unique per call) into the
 * dedup key here, once, rather than requiring every call site to remember to do it.
 */
async function insertInboxEvent(
  db: DbClient,
  id: string,
  dedupKey: string,
  eventType: string,
  payload: string,
): Promise<void> {
  const now = isoNow();
  try {
    await db.execute(
      `INSERT INTO inbox_events (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
       VALUES (?, ?, 'gitlab', ?, ?, ?, 'pending', 1, ?, ?)`,
      [id, `${dedupKey}:${id}`, eventType, payload, SCHEMA_VERSION, now, now],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique/i.test(msg)) {
      throw new Error(
        `An identical simulated event was already queued this same millisecond — try again.`,
      );
    }
    throw err;
  }
}

export function createGitlabCommand(): Command {
  const gitlab = new Command('gitlab').description(
    'GitLab event simulation commands (development/test/ci only)',
  );

  gitlab
    .command('simulate-pr-opened')
    .description('Simulate a merge request opened event')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'Merge request iid', parseInt)
    .option('--feature-run <id>', 'Feature run ID')
    .option('--head-sha <sha>', 'HEAD commit SHA', 'abc000000000')
    .action(
      async (opts: { project: string; prNumber: number; featureRun?: string; headSha: string }) => {
        guardEnv();
        const db = await createDbClientFromEnv();
        try {
          await insertInboxEvent(
            db,
            `sim-pr-opened-${opts.project}-${opts.prNumber}-${Date.now()}`,
            `gitlab:pr.opened:${opts.project}:${opts.prNumber}`,
            'pr.opened',
            JSON.stringify({
              projectId: opts.project,
              prNumber: opts.prNumber,
              featureRunId: opts.featureRun ?? null,
              headSha: opts.headSha,
              action: 'open',
            }),
          );
          console.log(
            JSON.stringify(
              {
                event: 'pr.opened',
                prNumber: opts.prNumber,
                projectId: opts.project,
                timestamp: isoNow(),
              },
              null,
              2,
            ),
          );
        } finally {
          await db.close();
        }
      },
    );

  gitlab
    .command('simulate-pr-closed')
    .description('Simulate a merge request closed event')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'Merge request iid', parseInt)
    .action(async (opts: { project: string; prNumber: number }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-pr-closed-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `gitlab:pr.closed:${opts.project}:${opts.prNumber}`,
          'pr.closed',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            action: 'close',
            merged: false,
          }),
        );
        console.log(
          JSON.stringify(
            {
              event: 'pr.closed',
              prNumber: opts.prNumber,
              projectId: opts.project,
              timestamp: isoNow(),
            },
            null,
            2,
          ),
        );
      } finally {
        await db.close();
      }
    });

  gitlab
    .command('simulate-pr-merged')
    .description('Simulate a merge request merged event')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'Merge request iid', parseInt)
    .option('--merge-sha <sha>', 'Merge commit SHA', 'merge000000')
    .action(async (opts: { project: string; prNumber: number; mergeSha: string }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-pr-merged-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `gitlab:pr.merged:${opts.project}:${opts.prNumber}`,
          'pr.merged',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            action: 'merge',
            merged: true,
            mergeSha: opts.mergeSha,
          }),
        );
        console.log(
          JSON.stringify(
            {
              event: 'pr.merged',
              prNumber: opts.prNumber,
              mergeSha: opts.mergeSha,
              projectId: opts.project,
              timestamp: isoNow(),
            },
            null,
            2,
          ),
        );
      } finally {
        await db.close();
      }
    });

  gitlab
    .command('simulate-check-passed')
    .description('Simulate a successful pipeline')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'Merge request iid', parseInt)
    .action(async (opts: { project: string; prNumber: number }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-check-passed-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `gitlab:check.passed:${opts.project}:${opts.prNumber}`,
          'check.passed',
          JSON.stringify({ projectId: opts.project, prNumber: opts.prNumber, status: 'success' }),
        );
        console.log(
          JSON.stringify(
            {
              event: 'check.passed',
              prNumber: opts.prNumber,
              projectId: opts.project,
              timestamp: isoNow(),
            },
            null,
            2,
          ),
        );
      } finally {
        await db.close();
      }
    });

  gitlab
    .command('simulate-check-failed')
    .description('Simulate a failed pipeline')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'Merge request iid', parseInt)
    .action(async (opts: { project: string; prNumber: number }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-check-failed-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `gitlab:check.failed:${opts.project}:${opts.prNumber}`,
          'check.failed',
          JSON.stringify({ projectId: opts.project, prNumber: opts.prNumber, status: 'failed' }),
        );
        console.log(
          JSON.stringify(
            {
              event: 'check.failed',
              prNumber: opts.prNumber,
              projectId: opts.project,
              timestamp: isoNow(),
            },
            null,
            2,
          ),
        );
      } finally {
        await db.close();
      }
    });

  gitlab
    .command('simulate-review-approved')
    .description('Simulate a merge request approval')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'Merge request iid', parseInt)
    .option('--reviewer <username>', 'Reviewer GitLab username', 'test-reviewer')
    .action(async (opts: { project: string; prNumber: number; reviewer: string }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-review-approved-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `gitlab:review.approved:${opts.project}:${opts.prNumber}:${opts.reviewer}`,
          'review.approved',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            reviewer: opts.reviewer,
          }),
        );
        console.log(
          JSON.stringify(
            {
              event: 'review.approved',
              reviewer: opts.reviewer,
              prNumber: opts.prNumber,
              projectId: opts.project,
              timestamp: isoNow(),
            },
            null,
            2,
          ),
        );
      } finally {
        await db.close();
      }
    });

  // Not guarded by guardEnv(): unlike simulate-*, `serve` is the real webhook receiver — same
  // posture as `minicoder github serve`/`minicoder gitea serve`.
  gitlab
    .command('serve')
    .description('Start the standalone GitLab webhook receiver (POST /webhooks/gitlab)')
    .option('--port <number>', 'Port to listen on', (v) => parseInt(v, 10), 3102)
    .option('--host <host>', 'Host to bind to', '0.0.0.0')
    .action(async (opts: { port: number; host: string }) => {
      const secret = process.env['GITLAB_WEBHOOK_SECRET'];
      if (!secret) {
        console.error('Error: GITLAB_WEBHOOK_SECRET must be set to run minicoder gitlab serve.');
        process.exit(1);
      }
      const previousSecret = process.env['GITLAB_WEBHOOK_SECRET_PREVIOUS'];
      const secrets = previousSecret ? [secret, previousSecret] : [secret];

      const db = await createDbClientFromEnv();
      const app = createGitlabWebhookApp({ db, secrets });
      try {
        const address = await app.listen({ port: opts.port, host: opts.host });
        console.log(`minicoder gitlab webhook receiver listening at ${address}`);
      } catch (err) {
        console.error('Error: failed to start webhook receiver:', err);
        process.exit(1);
      }
    });

  return gitlab;
}
