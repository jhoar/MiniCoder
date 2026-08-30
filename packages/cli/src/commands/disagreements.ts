import { Command } from 'commander';
import { renderDisagreementsView } from '@minicoder/tui/views';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createDisagreementsCommand(): Command {
  return new Command('disagreements')
    .description('Coder/reviewer disagreement records')
    .option('--feature-run <id>', 'Feature run ID')
    .option('--state <state>', 'Filter by disagreement state (open|escalated|resolved)')
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--limit <n>', 'Page size (1-100)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: { featureRun?: string; state?: string; cursor?: string; limit?: string } & JsonOption,
      ) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () =>
            client.listDisagreements(
              { featureRunId: opts.featureRun, state: opts.state },
              { cursor: opts.cursor, limit: opts.limit },
            ),
          (page) => renderDisagreementsView(page),
        );
      },
    );
}
