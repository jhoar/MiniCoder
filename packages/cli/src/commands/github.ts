import { Command } from 'commander';
import { createDbClientFromEnv } from '../db-client.js';

const ALLOWED_ENVS = new Set(['development', 'test', 'ci']);

function guardEnv(): void {
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
          const payload = JSON.stringify({
            projectId: opts.project,
            prNumber: opts.prNumber,
            featureRunId: opts.featureRun ?? null,
            headSha: opts.headSha,
            action: 'opened',
          });
          await db.execute(
            `INSERT INTO inbox_events (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
           VALUES (?, ?, 'github', 'pr.opened', ?, '1.0', 'pending', 1, datetime('now'), datetime('now'))`,
            [
              `sim-pr-opened-${opts.project}-${opts.prNumber}-${Date.now()}`,
              `github:pr.opened:${opts.project}:${opts.prNumber}`,
              payload,
            ],
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
        const payload = JSON.stringify({
          projectId: opts.project,
          prNumber: opts.prNumber,
          action: 'closed',
          merged: opts.merged,
        });
        await db.execute(
          `INSERT INTO inbox_events (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
           VALUES (?, ?, 'github', 'pr.closed', ?, '1.0', 'pending', 1, datetime('now'), datetime('now'))`,
          [
            `sim-pr-closed-${opts.project}-${opts.prNumber}-${Date.now()}`,
            `github:pr.closed:${opts.project}:${opts.prNumber}`,
            payload,
          ],
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
        const payload = JSON.stringify({
          projectId: opts.project,
          prNumber: opts.prNumber,
          action: 'closed',
          merged: true,
          mergeSha: opts.mergeSha,
        });
        await db.execute(
          `INSERT INTO inbox_events (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
           VALUES (?, ?, 'github', 'pr.merged', ?, '1.0', 'pending', 1, datetime('now'), datetime('now'))`,
          [
            `sim-pr-merged-${opts.project}-${opts.prNumber}-${Date.now()}`,
            `github:pr.merged:${opts.project}:${opts.prNumber}`,
            payload,
          ],
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
        const payload = JSON.stringify({
          projectId: opts.project,
          prNumber: opts.prNumber,
          checkName: opts.checkName,
          conclusion: 'success',
        });
        await db.execute(
          `INSERT INTO inbox_events (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
           VALUES (?, ?, 'github', 'check.passed', ?, '1.0', 'pending', 1, datetime('now'), datetime('now'))`,
          [
            `sim-check-passed-${opts.project}-${opts.prNumber}-${Date.now()}`,
            `github:check.passed:${opts.project}:${opts.prNumber}:${opts.checkName}`,
            payload,
          ],
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
        const payload = JSON.stringify({
          projectId: opts.project,
          prNumber: opts.prNumber,
          checkName: opts.checkName,
          conclusion: 'failure',
        });
        await db.execute(
          `INSERT INTO inbox_events (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
           VALUES (?, ?, 'github', 'check.failed', ?, '1.0', 'pending', 1, datetime('now'), datetime('now'))`,
          [
            `sim-check-failed-${opts.project}-${opts.prNumber}-${Date.now()}`,
            `github:check.failed:${opts.project}:${opts.prNumber}:${opts.checkName}`,
            payload,
          ],
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
        const payload = JSON.stringify({
          projectId: opts.project,
          prNumber: opts.prNumber,
          reviewer: opts.reviewer,
          state: 'approved',
        });
        await db.execute(
          `INSERT INTO inbox_events (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
           VALUES (?, ?, 'github', 'review.approved', ?, '1.0', 'pending', 1, datetime('now'), datetime('now'))`,
          [
            `sim-review-approved-${opts.project}-${opts.prNumber}-${Date.now()}`,
            `github:review.approved:${opts.project}:${opts.prNumber}:${opts.reviewer}`,
            payload,
          ],
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
        const payload = JSON.stringify({
          projectId: opts.project,
          prNumber: opts.prNumber,
          reviewer: opts.reviewer,
          state: 'changes_requested',
        });
        await db.execute(
          `INSERT INTO inbox_events (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
           VALUES (?, ?, 'github', 'review.changes_requested', ?, '1.0', 'pending', 1, datetime('now'), datetime('now'))`,
          [
            `sim-review-changes-${opts.project}-${opts.prNumber}-${Date.now()}`,
            `github:review.changes_requested:${opts.project}:${opts.prNumber}:${opts.reviewer}`,
            payload,
          ],
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
        const payload = JSON.stringify({
          projectId: opts.project,
          prNumber: opts.prNumber,
          protected: true,
        });
        await db.execute(
          `INSERT INTO inbox_events (id, dedup_key, source, event_type, payload, payload_schema_version, status, version, created_at, updated_at)
           VALUES (?, ?, 'github', 'branch.protection_ok', ?, '1.0', 'pending', 1, datetime('now'), datetime('now'))`,
          [
            `sim-branch-ok-${opts.project}-${opts.prNumber}-${Date.now()}`,
            `github:branch.protection_ok:${opts.project}:${opts.prNumber}`,
            payload,
          ],
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
