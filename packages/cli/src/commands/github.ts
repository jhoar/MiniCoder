import { Command } from 'commander';
import { createDbClientFromEnv } from '../db-client.js';

const ALLOWED_ENVS = new Set(['development', 'test', 'ci']);

function guardEnv(): void {
  if (process.env['APP_ENV'] === 'production' || process.env['NODE_ENV'] === 'production') {
    console.error(
      'Error: minicoder github commands are not permitted when APP_ENV or NODE_ENV is production.',
    );
    process.exit(1);
  }
  const env = process.env['APP_ENV'] ?? process.env['NODE_ENV'] ?? 'production';
  if (!ALLOWED_ENVS.has(env)) {
    console.error(
      `Error: minicoder github commands are only available in development/test/ci environments.\n` +
        `Current APP_ENV/NODE_ENV: '${env}'. Set APP_ENV=development to use this command.`,
    );
    process.exit(1);
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

type DbClient = Awaited<ReturnType<typeof createDbClientFromEnv>>;

async function insertInboxEvent(
  db: DbClient,
  id: string,
  dedupKey: string,
  eventType: string,
  payload: string,
): Promise<void> {
  const now = isoNow();
  await db.execute(
    `INSERT INTO inbox_events (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
     VALUES (?, ?, 'github', ?, ?, '1.0', 'pending', 1, ?, ?)`,
    [id, dedupKey, eventType, payload, now, now],
  );
}

export function createGithubCommand(): Command {
  const github = new Command('github').description(
    'GitHub event simulation commands (development/test/ci only)',
  );

  github
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
            `github:pr.opened:${opts.project}:${opts.prNumber}`,
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

  github
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
          `github:pr.closed:${opts.project}:${opts.prNumber}`,
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

  github
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
          `github:pr.merged:${opts.project}:${opts.prNumber}`,
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

  github
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
          `github:check.passed:${opts.project}:${opts.prNumber}:${opts.checkName}`,
          'check.passed',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            checkName: opts.checkName,
            conclusion: 'success',
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

  github
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
          `github:check.failed:${opts.project}:${opts.prNumber}:${opts.checkName}`,
          'check.failed',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            checkName: opts.checkName,
            conclusion: 'failure',
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

  github
    .command('simulate-review-approved')
    .description('Simulate a pull request review approval')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'PR number', parseInt)
    .option('--reviewer <login>', 'Reviewer GitHub login', 'test-reviewer')
    .action(async (opts: { project: string; prNumber: number; reviewer: string }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-review-approved-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `github:review.approved:${opts.project}:${opts.prNumber}:${opts.reviewer}`,
          'review.approved',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            reviewer: opts.reviewer,
            state: 'approved',
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

  github
    .command('simulate-review-changes-requested')
    .description('Simulate a pull request review requesting changes')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'PR number', parseInt)
    .option('--reviewer <login>', 'Reviewer GitHub login', 'test-reviewer')
    .action(async (opts: { project: string; prNumber: number; reviewer: string }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-review-changes-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `github:review.changes_requested:${opts.project}:${opts.prNumber}:${opts.reviewer}`,
          'review.changes_requested',
          JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            reviewer: opts.reviewer,
            state: 'changes_requested',
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

  github
    .command('simulate-branch-protection-ok')
    .description('Simulate branch protection rules passing')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--pr-number <number>', 'PR number', parseInt)
    .action(async (opts: { project: string; prNumber: number }) => {
      guardEnv();
      const db = await createDbClientFromEnv();
      try {
        await insertInboxEvent(
          db,
          `sim-branch-ok-${opts.project}-${opts.prNumber}-${Date.now()}`,
          `github:branch.protection_ok:${opts.project}:${opts.prNumber}`,
          'branch.protection_ok',
          JSON.stringify({ projectId: opts.project, prNumber: opts.prNumber, protected: true }),
        );
        console.log(
          JSON.stringify(
            {
              event: 'branch.protection_ok',
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

  return github;
}
