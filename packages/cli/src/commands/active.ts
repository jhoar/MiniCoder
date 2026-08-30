import { Command } from 'commander';
import { ApiError } from '@minicoder/tui/client';
import { renderActiveFeatureView } from '@minicoder/tui/views';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createActiveCommand(): Command {
  return new Command('active')
    .description("The project's active feature and its pull-request/CI state")
    .requiredOption('--project <id>', 'Project ID')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string } & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const { automationState, activeFeatureRun } = await client.getActiveFeature(opts.project);
          let pullRequest = null;
          if (activeFeatureRun) {
            try {
              pullRequest = await client.getPullRequestByFeatureRun(activeFeatureRun.id);
            } catch (err) {
              // No PR tracked yet for this feature run (e.g. still `coding`) — not an error.
              if (!(err instanceof ApiError) || err.status !== 404) throw err;
            }
          }
          return { automationState, activeFeatureRun, pullRequest };
        },
        (data) => renderActiveFeatureView(data),
      );
    });
}
