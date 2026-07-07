import { Command } from 'commander';
import { renderFindingsView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createFindingsCommand(): Command {
  return new Command('findings')
    .description('Review findings for a feature run')
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--limit <n>', 'Page size (1-100)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { featureRun: string; cursor?: string; limit?: string } & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        () =>
          client.listReviewFindings(opts.featureRun, { cursor: opts.cursor, limit: opts.limit }),
        (page) => renderFindingsView(page),
      );
    });
}
