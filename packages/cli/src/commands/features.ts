import { Command } from 'commander';
import { renderFeaturesView, renderHumanRequiredView } from '@minicoder/tui/views';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createFeaturesCommand(): Command {
  return new Command('features')
    .description('Feature queue — pass --human-required to show only items awaiting a human')
    .requiredOption('--project <id>', 'Project ID')
    .option(
      '--human-required',
      'Show feature runs parked at human_required instead of the full feature queue ' +
        '(feature_requests.state is a static label and never reaches human_required — see CLAUDE.md)',
    )
    .option(
      '--full',
      'Show each feature\'s full description (word-wrapped, not truncated) instead of the ' +
        'fixed-width table — the table has no description column at all',
    )
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--limit <n>', 'Page size (1-100)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: {
          project: string;
          humanRequired?: boolean;
          full?: boolean;
          cursor?: string;
          limit?: string;
        } & JsonOption,
      ) => {
        const client = buildApiClient();
        const query = { cursor: opts.cursor, limit: opts.limit };
        if (opts.humanRequired) {
          await renderOrJson(
            opts,
            () => client.listHumanRequiredItems(opts.project, query),
            (page) => renderHumanRequiredView(page),
          );
        } else {
          await renderOrJson(
            opts,
            () => client.listFeatures(opts.project, query),
            (page) => renderFeaturesView(page, { full: opts.full }),
          );
        }
      },
    );
}
