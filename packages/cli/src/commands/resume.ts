import { randomUUID } from 'crypto';
import { Command } from 'commander';
import { renderCommandResultView } from '@minicoder/tui/views';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createResumeCommand(): Command {
  return new Command('resume')
    .description(
      'paused_by_operator -> running (records a resumed event, docs/05 §4) — requires an operator-or-above API key',
    )
    .requiredOption('--project <id>', 'Project ID')
    .option('--yes', 'Confirm the resume (required)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; yes?: boolean } & JsonOption) => {
      if (!opts.yes) {
        console.error('Error: --yes is required to confirm resuming automation.');
        process.exitCode = 1;
        return;
      }
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const status = await client.getStatus(opts.project);
          if (!status.workflowState) {
            throw new Error(`Project ${opts.project} has no workflow_states row to resume.`);
          }
          const idempotencyKey = `resume-automation:${opts.project}:${status.workflowState.version}:${randomUUID()}`;
          const result = await client.resumeAutomation(
            opts.project,
            status.workflowState.version,
            idempotencyKey,
          );
          return {
            command: 'resume-automation',
            projectId: opts.project,
            resultingState: result.resulting_state,
          };
        },
        (data) => renderCommandResultView(data),
      );
    });
}
