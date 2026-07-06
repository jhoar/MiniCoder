import { Command } from 'commander';
import { renderClarificationView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createClarificationCommand(): Command {
  return new Command('clarification')
    .description('Clarification sessions and questions')
    .requiredOption('--project <id>', 'Project ID')
    .option('--session <id>', 'Show questions for a specific clarification session')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; session?: string } & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const [sessions, detail] = await Promise.all([
            client.listClarificationSessions(opts.project),
            opts.session
              ? client.getClarificationSession(opts.session)
              : Promise.resolve(undefined),
          ]);
          return { sessions, detail };
        },
        (data) => renderClarificationView(data),
      );
    });
}
