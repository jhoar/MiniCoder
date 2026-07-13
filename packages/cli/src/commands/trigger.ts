import { Command } from 'commander';
import { generateId } from '@minicoder/core';
import { ALL_TASK_IDS, TASK_REGISTRY, TaskQueueDispatcher } from '@minicoder/triggerdev';
import { createDbClientFromEnv } from '../db-client.js';

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Trigger.dev replacement: `task_queue`/`triggerdev_runs` are now local tables, not a proxy to an
 * external management API — every subcommand below except `deploy` (nothing external to deploy
 * to anymore) is now real, DB-backed functionality, closing the permanent-stub posture this
 * command group carried while `TRIGGERDEV_API_URL`/`TRIGGERDEV_API_KEY` (Trigger.dev's own
 * management API) remained out of scope.
 */
export function createTriggerCommand(): Command {
  const trigger = new Command('trigger').description(
    'Task-queue lifecycle commands (Trigger.dev replacement)',
  );

  trigger
    .command('deploy')
    .description('No-op: task registration is compiled into the worker binary, nothing to deploy')
    .action(() => {
      console.log(
        JSON.stringify(
          {
            command: 'trigger deploy',
            note:
              'There is no external Workflow Layer deployment step anymore — TASK_REGISTRY ' +
              '(packages/triggerdev/src/task-registry.ts) is compiled into whatever process runs ' +
              '`minicoder tasks worker`. Ship a new task by shipping a new build/release of that ' +
              'process.',
            taskIds: ALL_TASK_IDS,
            timestamp: isoNow(),
          },
          null,
          2,
        ),
      );
    });

  trigger
    .command('list-runs')
    .description('List recent task_queue/triggerdev_runs entries')
    .option('--task <id>', 'Filter by task ID')
    .option('--limit <n>', 'Maximum rows to return', '20')
    .action(async (opts: { task?: string; limit: string }) => {
      const limit = parseInt(opts.limit, 10);
      const db = await createDbClientFromEnv();
      try {
        const rows = opts.task
          ? await db.query(
              `SELECT id, triggerdev_run_id, triggerdev_task_id, triggerdev_status, project_id, last_seen_at
               FROM triggerdev_runs WHERE triggerdev_task_id = ? ORDER BY last_seen_at DESC LIMIT ?`,
              [opts.task, limit],
            )
          : await db.query(
              `SELECT id, triggerdev_run_id, triggerdev_task_id, triggerdev_status, project_id, last_seen_at
               FROM triggerdev_runs ORDER BY last_seen_at DESC LIMIT ?`,
              [limit],
            );
        console.log(
          JSON.stringify(
            {
              command: 'trigger list-runs',
              taskId: opts.task ?? null,
              limit,
              runs: rows,
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

  trigger
    .command('inspect-run')
    .description(
      'Show detail for a specific run: its task_queue row and linked triggerdev_runs row',
    )
    .argument('<runId>', 'task_queue row id (also the triggerdev_run_id)')
    .action(async (runId: string) => {
      const db = await createDbClientFromEnv();
      try {
        const queueRows = await db.query('SELECT * FROM task_queue WHERE id = ?', [runId]);
        const statusRows = await db.query(
          'SELECT * FROM triggerdev_runs WHERE triggerdev_run_id = ?',
          [runId],
        );
        console.log(
          JSON.stringify(
            {
              command: 'trigger inspect-run',
              runId,
              taskQueueRow: queueRows[0] ?? null,
              triggerdevRunRow: statusRows[0] ?? null,
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

  trigger
    .command('cancel-run')
    .description('Force-fail a stuck or unwanted task_queue row so the worker stops retrying it')
    .argument('<runId>', 'task_queue row id')
    .action(async (runId: string) => {
      const db = await createDbClientFromEnv();
      try {
        // A large sentinel attempts count, not a specific maxAttempts value — the worker's
        // retry-eligibility guard (`attempts < maxAttempts`) must exclude this row regardless of
        // whatever maxAttempts a given `minicoder tasks worker` instance is configured with.
        const affected = await db.executeAffected(
          `UPDATE task_queue SET status = 'failed', attempts = 1000000, version = version + 1, updated_at = ? WHERE id = ?`,
          [isoNow(), runId],
        );
        console.log(
          JSON.stringify(
            { command: 'trigger cancel-run', runId, cancelled: affected > 0, timestamp: isoNow() },
            null,
            2,
          ),
        );
        if (affected === 0) process.exitCode = 1;
      } finally {
        await db.close();
      }
    });

  trigger
    .command('replay-run')
    .description(
      'Re-enqueue a task_queue row with the same task/payload and a fresh idempotency key',
    )
    .argument('<runId>', 'task_queue row id to replay')
    .action(async (runId: string) => {
      const db = await createDbClientFromEnv();
      try {
        const rows = await db.query<{ task_id: string; payload: string }>(
          'SELECT task_id, payload FROM task_queue WHERE id = ?',
          [runId],
        );
        const source = rows[0];
        if (!source) {
          console.error(`Error: no task_queue row found for id '${runId}'`);
          process.exitCode = 1;
          return;
        }
        const newId = generateId();
        const now = isoNow();
        await db.execute(
          `INSERT INTO task_queue (id, task_id, payload, idempotency_key, status, attempts, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, 1, ?, ?)`,
          [newId, source.task_id, source.payload, `replay-${runId}-${newId}`, now, now],
        );
        console.log(
          JSON.stringify(
            {
              command: 'trigger replay-run',
              sourceRunId: runId,
              newRunId: newId,
              taskId: source.task_id,
              timestamp: now,
            },
            null,
            2,
          ),
        );
      } finally {
        await db.close();
      }
    });

  trigger
    .command('drain-queue')
    .description('Wait for the task queue to empty (dev/CI use)')
    .option('--timeout-ms <ms>', 'Maximum wait in milliseconds', '60000')
    .option('--poll-interval-ms <ms>', 'Milliseconds between poll ticks', '500')
    .action(async (opts: { timeoutMs: string; pollIntervalMs: string }) => {
      const timeoutMs = parseInt(opts.timeoutMs, 10);
      const pollIntervalMs = parseInt(opts.pollIntervalMs, 10);
      const db = await createDbClientFromEnv();
      const dispatcher = new TaskQueueDispatcher(db);
      const deadline = Date.now() + timeoutMs;
      try {
        while (Date.now() < deadline) {
          await dispatcher.pollAndDispatch();
          if (await dispatcher.isEmpty()) {
            console.log(
              JSON.stringify(
                { command: 'trigger drain-queue', drained: true, timestamp: isoNow() },
                null,
                2,
              ),
            );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        console.error(
          `Error: trigger drain-queue timed out after ${timeoutMs}ms with work remaining`,
        );
        process.exitCode = 1;
      } finally {
        await db.close();
      }
    });

  trigger
    .command('reset-dev')
    .description('Clear all task_queue rows (dev/CI only)')
    .option('--yes', 'Confirm the destructive reset operation')
    .option('--env <environment>', 'Target environment — must be development, test, or ci')
    .action(async (opts: { yes?: boolean; env?: string }) => {
      if (!opts.yes || !opts.env) {
        console.error(
          'Error: --yes and --env <environment> flags are required.\nExample: minicoder trigger reset-dev --yes --env development',
        );
        process.exitCode = 1;
        return;
      }
      const permitted = ['development', 'test', 'ci'];
      if (!permitted.includes(opts.env as string)) {
        console.error(`Error: --env must be one of: ${permitted.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      // PR #75 review fix (HIGH-3): matches the stricter guardEnv() precedent already established
      // in packages/cli/src/commands/{db,github}.ts for dev/test/CI-only destructive commands.
      // An earlier revision special-cased an EMPTY systemEnv as "safe" (skipping this check
      // entirely) — but this command performs a real `DELETE FROM task_queue` (unlike when this
      // guard was first written, against a permanent `notImplemented()` stub that never touched
      // the database), so unset APP_ENV/NODE_ENV must never be inferred as safe. Defaulting the
      // unset case to 'production' (a value never in `permitted`) makes it fail closed instead.
      const systemEnv = process.env['APP_ENV'] ?? process.env['NODE_ENV'] ?? 'production';
      if (!permitted.includes(systemEnv)) {
        console.error(
          `Error: system env APP_ENV/NODE_ENV is '${systemEnv}' which is not safe. Reset blocked.`,
        );
        process.exitCode = 1;
        return;
      }
      const db = await createDbClientFromEnv();
      try {
        const deleted = await db.executeAffected('DELETE FROM task_queue');
        console.log(
          JSON.stringify(
            {
              command: 'trigger reset-dev',
              environment: opts.env,
              systemEnv,
              deleted,
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

  trigger
    .command('validate')
    .description('Check that every canonical task ID has a TASK_REGISTRY entry')
    .action(() => {
      const missing = ALL_TASK_IDS.filter((id) => !TASK_REGISTRY.has(id));
      console.log(
        JSON.stringify(
          {
            command: 'trigger validate',
            taskIds: ALL_TASK_IDS,
            taskCount: ALL_TASK_IDS.length,
            status: missing.length === 0 ? 'ok' : 'mismatch',
            missing,
            timestamp: isoNow(),
          },
          null,
          2,
        ),
      );
      if (missing.length > 0) process.exitCode = 1;
    });

  trigger
    .command('reconcile')
    .description('Compare task_queue against triggerdev_runs and flag drift')
    .option('--project <id>', 'Project ID')
    .action(async (opts: { project?: string }) => {
      const db = await createDbClientFromEnv();
      try {
        // A task_queue row past 'pending'/'processing' with no matching triggerdev_runs row at
        // all means the worker never linked it — either it was force-cancelled before ever being
        // claimed (expected, not drift) or a worker crashed before its first linkRunToDb() write
        // (real drift worth flagging).
        const orphanedQueueRows = opts.project
          ? await db.query(
              `SELECT tq.id, tq.task_id, tq.status, tq.attempts
               FROM task_queue tq
               WHERE tq.status IN ('processing', 'succeeded')
                 AND tq.project_id = ?
                 AND NOT EXISTS (SELECT 1 FROM triggerdev_runs tr WHERE tr.triggerdev_run_id = tq.id)`,
              [opts.project],
            )
          : await db.query(
              `SELECT tq.id, tq.task_id, tq.status, tq.attempts
               FROM task_queue tq
               WHERE tq.status IN ('processing', 'succeeded')
                 AND NOT EXISTS (SELECT 1 FROM triggerdev_runs tr WHERE tr.triggerdev_run_id = tq.id)`,
            );
        console.log(
          JSON.stringify(
            {
              command: 'trigger reconcile',
              projectId: opts.project ?? null,
              orphanedQueueRows,
              driftDetected: orphanedQueueRows.length > 0,
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

  return trigger;
}
