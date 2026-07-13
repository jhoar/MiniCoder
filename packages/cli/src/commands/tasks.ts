import { Command } from 'commander';
import { createDbClientFromEnv, TaskQueueDispatcher } from '@minicoder/triggerdev';

/**
 * `minicoder tasks worker` / `minicoder tasks drain` — the Trigger.dev replacement's task-queue
 * worker CLI, mirroring `minicoder api serve`/`minicoder github serve`'s "long-running process,
 * stays alive until terminated" shape for `worker`, and standing in for the never-built
 * `trigger drain-queue` stub for `drain` (CI/test convenience: wait for the queue to empty).
 */
export function createTasksCommand(): Command {
  const tasks = new Command('tasks').description(
    'Task-queue worker commands (Trigger.dev replacement)',
  );

  tasks
    .command('worker')
    .description('Poll task_queue and execute claimed tasks until terminated')
    .option(
      '--poll-interval-ms <ms>',
      'Milliseconds between poll ticks',
      (v) => parseInt(v, 10),
      Number(process.env['TASK_WORKER_POLL_INTERVAL_MS'] ?? '2000'),
    )
    .option(
      '--batch-size <n>',
      'Maximum rows claimed per poll tick',
      (v) => parseInt(v, 10),
      Number(process.env['TASK_WORKER_BATCH_SIZE'] ?? '10'),
    )
    .option(
      '--stale-claim-ms <ms>',
      'Reclaim a row stuck in "processing" after this many milliseconds',
      (v) => parseInt(v, 10),
      Number(process.env['TASK_WORKER_STALE_CLAIM_MS'] ?? '300000'),
    )
    .action(async (opts: { pollIntervalMs: number; batchSize: number; staleClaimMs: number }) => {
      const db = await createDbClientFromEnv();
      const dispatcher = new TaskQueueDispatcher(db, {
        batchSize: opts.batchSize,
        staleClaimMs: opts.staleClaimMs,
      });

      let ticking = false;
      let shuttingDown = false;

      const tick = async (): Promise<void> => {
        if (ticking || shuttingDown) return;
        ticking = true;
        try {
          const { dispatched, failed } = await dispatcher.pollAndDispatch();
          if (dispatched > 0 || failed > 0) {
            console.log(
              JSON.stringify({
                event: 'poll',
                dispatched,
                failed,
                timestamp: new Date().toISOString(),
              }),
            );
          }
        } catch (err) {
          console.error('minicoder tasks worker: poll tick failed:', err);
        } finally {
          ticking = false;
        }
      };

      const interval = setInterval(() => void tick(), opts.pollIntervalMs);
      console.log(
        `minicoder tasks worker started (pollIntervalMs=${opts.pollIntervalMs}, batchSize=${opts.batchSize}, staleClaimMs=${opts.staleClaimMs})`,
      );

      const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`minicoder tasks worker: received ${signal}, finishing in-flight work...`);
        clearInterval(interval);
        // Let an in-flight tick's claimed rows run to completion before closing the DB.
        while (ticking) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await db.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
    });

  tasks
    .command('drain')
    .description('Poll task_queue until it is empty or --timeout-ms elapses (CI/test use)')
    .option('--timeout-ms <ms>', 'Maximum time to wait', (v) => parseInt(v, 10), 60_000)
    .option(
      '--poll-interval-ms <ms>',
      'Milliseconds between poll ticks',
      (v) => parseInt(v, 10),
      500,
    )
    .action(async (opts: { timeoutMs: number; pollIntervalMs: number }) => {
      const db = await createDbClientFromEnv();
      const dispatcher = new TaskQueueDispatcher(db);
      const deadline = Date.now() + opts.timeoutMs;

      try {
        while (Date.now() < deadline) {
          await dispatcher.pollAndDispatch();
          if (await dispatcher.isEmpty()) {
            console.log('minicoder tasks drain: queue empty');
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
        }
        console.error(
          `minicoder tasks drain: timed out after ${opts.timeoutMs}ms with work remaining`,
        );
        process.exitCode = 1;
      } finally {
        await db.close();
      }
    });

  return tasks;
}
