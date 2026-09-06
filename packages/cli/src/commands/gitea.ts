/**
 * `minicoder gitea ...` — mirrors `minicoder github ...` (`./github.ts`) exactly, adjusted for
 * Gitea's wire format (docs/06 §Phase 18 Stage 3). Kept as its own top-level command group rather
 * than folded into a generalized `minicoder scm ... --provider <p>` — each SCM provider gets its
 * own command group named after itself, the same pattern already established for `packages/github`
 * itself staying named as such rather than being folded into a generic `packages/scm`.
 *
 * `simulate-branch-protection-ok` has no Gitea equivalent here: it is GitHub-specific dev-tooling
 * with no real webhook event behind it even on the GitHub side (`@minicoder/github`'s own
 * `normalize.ts` doc comment), so there is nothing Gitea-specific to mirror.
 */
import { Command } from 'commander';
import { createDbClientFromEnv } from '../db-client.js';
import { createGiteaWebhookApp } from '@minicoder/gitea';
import { SCHEMA_VERSION } from '@minicoder/core';

const ALLOWED_ENVS = new Set(['development', 'test', 'ci']);

function guardEnv(): void {
  if (process.env['APP_ENV'] === 'production' || process.env['NODE_ENV'] === 'production') {
    console.error(
      'Error: minicoder gitea commands are not permitted when APP_ENV or NODE_ENV is production.',
    );
    process.exit(1);
  }
  const env = process.env['APP_ENV'] ?? process.env['NODE_ENV'] ?? 'production';
  if (!ALLOWED_ENVS.has(env)) {
    console.error(
      `Error: minicoder gitea commands are only available in development/test/ci environments.\n` +
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
       VALUES (?, ?, 'gitea', ?, ?, ?, 'pending', 1, ?, ?)`,
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

export function createGiteaCommand(): Command {
  const gitea = new Command('gitea').description(
    'Gitea event simulation commands (development/test/ci only)',
  );

  gitea
    .command('simulate-pr-opened')
    .description('Simulate a pull request opened event')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'PR number', parseInt)
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
            `gitea:pr.opened:${opts.project}:${opts.prNumber}`,
            'pr.opened',
            JSON.stringify({
              projectId: opts.project,
              prNumber: opts.prNumber,
              featureRunId: opts.featureRun ?? null,
              headSha: opts.headSha,
              action: 'opened',
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

  gitea
    .command('simulate-pr-closed')
    .description('Simulate a pull request closed event')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'PR number', parseInt)
    .option('--merged', 'Mark PR as merged', false)
    .action(async (opts: { project: string; prNumber: number; merged: boolean }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-pr-closed-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `gitea:pr.closed:${opts.project}:${opts.prNumber}`,
          'pr.closed',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            action: 'closed',
            merged: opts.merged,
          }),
        );
        console.log(
          JSON.stringify(
            {
              event: 'pr.closed',
              prNumber: opts.prNumber,
              merged: opts.merged,
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

  gitea
    .command('simulate-pr-merged')
    .description('Simulate a pull request merged event')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'PR number', parseInt)
    .option('--merge-sha <sha>', 'Merge commit SHA', 'merge000000')
    .action(async (opts: { project: string; prNumber: number; mergeSha: string }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-pr-merged-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `gitea:pr.merged:${opts.project}:${opts.prNumber}`,
          'pr.merged',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            action: 'closed',
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

  gitea
    .command('simulate-check-passed')
    .description('Simulate a CI check passing')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'PR number', parseInt)
    .option('--check-name <name>', 'Check name', 'ci/test')
    .action(async (opts: { project: string; prNumber: number; checkName: string }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-check-passed-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `gitea:check.passed:${opts.project}:${opts.prNumber}:${opts.checkName}`,
          'check.passed',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            checkName: opts.checkName,
            state: 'success',
          }),
        );
        console.log(
          JSON.stringify(
            {
              event: 'check.passed',
              checkName: opts.checkName,
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

  gitea
    .command('simulate-check-failed')
    .description('Simulate a CI check failing')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'PR number', parseInt)
    .option('--check-name <name>', 'Check name', 'ci/test')
    .action(async (opts: { project: string; prNumber: number; checkName: string }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-check-failed-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `gitea:check.failed:${opts.project}:${opts.prNumber}:${opts.checkName}`,
          'check.failed',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            checkName: opts.checkName,
            state: 'failure',
          }),
        );
        console.log(
          JSON.stringify(
            {
              event: 'check.failed',
              checkName: opts.checkName,
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

  gitea
    .command('simulate-review-approved')
    .description('Simulate a pull request review approval')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'PR number', parseInt)
    .option('--reviewer <login>', 'Reviewer Gitea login', 'test-reviewer')
    .action(async (opts: { project: string; prNumber: number; reviewer: string }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-review-approved-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `gitea:review.approved:${opts.project}:${opts.prNumber}:${opts.reviewer}`,
          'review.approved',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            reviewer: opts.reviewer,
            reviewType: 'pull_request_review_approve',
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

  gitea
    .command('simulate-review-changes-requested')
    .description('Simulate a pull request review requesting changes')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'PR number', parseInt)
    .option('--reviewer <login>', 'Reviewer Gitea login', 'test-reviewer')
    .action(async (opts: { project: string; prNumber: number; reviewer: string }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-review-changes-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `gitea:review.changes_requested:${opts.project}:${opts.prNumber}:${opts.reviewer}`,
          'review.changes_requested',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            reviewer: opts.reviewer,
            reviewType: 'pull_request_review_reject',
          }),
        );
        console.log(
          JSON.stringify(
            {
              event: 'review.changes_requested',
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
  // posture as `minicoder github serve`.
  gitea
    .command('serve')
    .description('Start the standalone Gitea webhook receiver (POST /webhooks/gitea)')
    .option('--port <number>', 'Port to listen on', (v) => parseInt(v, 10), 3101)
    .option('--host <host>', 'Host to bind to', '0.0.0.0')
    .action(async (opts: { port: number; host: string }) => {
      const secret = process.env['GITEA_WEBHOOK_SECRET'];
      if (!secret) {
        console.error('Error: GITEA_WEBHOOK_SECRET must be set to run minicoder gitea serve.');
        process.exit(1);
      }
      const previousSecret = process.env['GITEA_WEBHOOK_SECRET_PREVIOUS'];
      const secrets = previousSecret ? [secret, previousSecret] : [secret];

      const db = await createDbClientFromEnv();
      const app = createGiteaWebhookApp({ db, secrets });
      try {
        const address = await app.listen({ port: opts.port, host: opts.host });
        console.log(`minicoder gitea webhook receiver listening at ${address}`);
      } catch (err) {
        console.error('Error: failed to start webhook receiver:', err);
        process.exit(1);
      }
    });

  return gitea;
}
