import { Command } from 'commander';
import { renderArtifactsView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createArtifactsCommand(): Command {
  return new Command('artifacts')
    .description('Artifact exports (plan.md/backlog.md snapshots, etc.)')
    .requiredOption('--project <id>', 'Project ID')
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--limit <n>', 'Page size (1-100)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; cursor?: string; limit?: string } & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        () => client.listArtifactExports(opts.project, { cursor: opts.cursor, limit: opts.limit }),
        (page) => renderArtifactsView(page),
      );
    });
}
