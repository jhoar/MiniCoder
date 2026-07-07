import { Command } from 'commander';
import { renderRunsView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createRunsCommand(): Command {
  return new Command('runs')
    .description('Agent runs')
    .option('--project <id>', 'Project ID')
    .option('--feature-run <id>', 'Feature run ID')
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--limit <n>', 'Page size (1-100)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: {
          project?: string;
          featureRun?: string;
          cursor?: string;
          limit?: string;
        } & JsonOption,
      ) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () =>
            client.listAgentRuns(
              { projectId: opts.project, featureRunId: opts.featureRun },
              { cursor: opts.cursor, limit: opts.limit },
            ),
          (page) => renderRunsView(page),
        );
      },
    );
}
