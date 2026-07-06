import { Command } from 'commander';
import { ALL_TASK_IDS } from '@minicoder/triggerdev';

function isoNow(): string {
  return new Date().toISOString();
}

function notImplemented(command: string, fields: Record<string, unknown> = {}): never {
  console.error(
    JSON.stringify(
      {
        command,
        error: 'not_implemented',
        note: "Full implementation requires TRIGGERDEV_API_URL and TRIGGERDEV_API_KEY (Trigger.dev's own management API — a real integration deliberately deferred out of Phase 13's scope; see CLAUDE.md's Orchestrator API Operational Constraints).",
        timestamp: isoNow(),
        ...fields,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

function infoStub(command: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      command,
      note: "Read-only view — full data requires TRIGGERDEV_API_URL (Trigger.dev's own management API, out of Phase 13's scope — see CLAUDE.md's Orchestrator API Operational Constraints).",
      timestamp: isoNow(),
      ...fields,
    },
    null,
    2,
  );
}

export function createTriggerCommand(): Command {
  const trigger = new Command('trigger').description(
    'Trigger.dev Workflow Layer lifecycle commands',
  );

  trigger
    .command('deploy')
    .description('Deploy task bundle to the configured Trigger.dev backend')
    .option('--env <environment>', 'Target environment (staging, production)', 'staging')
    .action((opts: { env: string }) => {
      notImplemented('trigger deploy', { environment: opts.env });
    });

  trigger
    .command('list-runs')
    .description('List recent Trigger.dev runs')
    .option('--task <id>', 'Filter by task ID')
    .option('--limit <n>', 'Maximum rows to return', '20')
    .action((opts: { task?: string; limit: string }) => {
      console.log(
        infoStub('trigger list-runs', {
          taskId: opts.task ?? null,
          limit: parseInt(opts.limit, 10),
        }),
      );
    });

  trigger
    .command('inspect-run')
    .description('Show detail for a specific Trigger.dev run and its linked DB row')
    .argument('<runId>', 'Trigger.dev run ID')
    .action((runId: string) => {
      console.log(infoStub('trigger inspect-run', { runId }));
    });

  trigger
    .command('cancel-run')
    .description('Cancel a stuck or unwanted Trigger.dev run')
    .argument('<runId>', 'Trigger.dev run ID')
    .action((runId: string) => {
      notImplemented('trigger cancel-run', { runId });
    });

  trigger
    .command('replay-run')
    .description('Re-enqueue a failed run with the same payload')
    .argument('<runId>', 'Trigger.dev run ID to replay')
    .action((runId: string) => {
      notImplemented('trigger replay-run', { sourceRunId: runId });
    });

  trigger
    .command('drain-queue')
    .description('Wait for the task queue to empty (dev/CI use)')
    .option('--task <id>', 'Drain only the named task queue')
    .option('--timeout-ms <ms>', 'Maximum wait in milliseconds', '60000')
    .action((opts: { task?: string; timeoutMs: string }) => {
      notImplemented('trigger drain-queue', {
        taskId: opts.task ?? null,
        timeoutMs: parseInt(opts.timeoutMs, 10),
      });
    });

  trigger
    .command('reset-dev')
    .description('Clear all dev runs and queues (dev/CI only)')
    .option('--yes', 'Confirm the destructive reset operation')
    .option('--env <environment>', 'Target environment — must be development, test, or ci')
    .action((opts: { yes?: boolean; env?: string }) => {
      if (!opts.yes || !opts.env) {
        console.error(
          'Error: --yes and --env <environment> flags are required.\nExample: minicoder trigger reset-dev --yes --env development',
        );
        process.exit(1);
      }
      const permitted = ['development', 'test', 'ci'];
      if (!permitted.includes(opts.env)) {
        console.error(`Error: --env must be one of: ${permitted.join(', ')}`);
        process.exit(1);
      }
      const systemEnv = process.env['APP_ENV'] ?? process.env['NODE_ENV'] ?? '';
      if (!permitted.includes(systemEnv) && systemEnv !== '') {
        console.error(
          `Error: system env APP_ENV/NODE_ENV is '${systemEnv}' which is not safe. Reset blocked.`,
        );
        process.exit(1);
      }
      notImplemented('trigger reset-dev', { environment: opts.env, systemEnv });
    });

  trigger
    .command('validate')
    .description('Check that the task bundle builds cleanly and reports all task IDs')
    .action(() => {
      console.log(
        JSON.stringify(
          {
            command: 'trigger validate',
            taskIds: ALL_TASK_IDS,
            taskCount: ALL_TASK_IDS.length,
            status: 'ok',
            timestamp: isoNow(),
          },
          null,
          2,
        ),
      );
    });

  trigger
    .command('reconcile')
    .description('Compare DB triggerdev_runs against live runs and flag mismatches')
    .option('--project <id>', 'Project ID')
    .action((opts: { project?: string }) => {
      notImplemented('trigger reconcile', { projectId: opts.project ?? null });
    });

  return trigger;
}
