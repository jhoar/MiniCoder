import { randomUUID } from 'crypto';
import { Command } from 'commander';
import { renderCommandResultView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createPauseCommand(): Command {
  return new Command('pause')
    .description(
      'running -> paused_by_operator (docs/05 §4) — requires an operator-or-above API key',
    )
    .requiredOption('--project <id>', 'Project ID')
    .option('--yes', 'Confirm the pause (required)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; yes?: boolean } & JsonOption) => {
      if (!opts.yes) {
        console.error('Error: --yes is required to confirm pausing automation.');
        process.exitCode = 1;
        return;
      }
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const status = await client.getStatus(opts.project);
          if (!status.workflowState) {
            throw new Error(`Project ${opts.project} has no workflow_states row to pause.`);
          }
          // Fresh key per invocation: pause/resume can recur many times over a project's
          // lifetime, and the API requires a per-occurrence discriminator (expectedVersion) in
          // the Idempotency-Key so a later pause isn't silently replayed against an earlier one.
          const idempotencyKey = `pause-automation:${opts.project}:${status.workflowState.version}:${randomUUID()}`;
          const result = await client.pauseAutomation(
            opts.project,
            status.workflowState.version,
            idempotencyKey,
          );
          return {
            command: 'pause-automation',
            projectId: opts.project,
            resultingState: result.resulting_state,
          };
        },
        (data) => renderCommandResultView(data),
      );
    });
}
