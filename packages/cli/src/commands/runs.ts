import { Command } from 'commander';
import { renderRunsView, renderTimelineView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createRunsCommand(): Command {
  return new Command('runs')
    .description('Agent runs')
    .option('--project <id>', 'Project ID')
    .option('--feature-run <id>', 'Feature run ID')
    .option(
      '--timeline <featureRunId>',
      'Show the merged chronological workflow timeline for one feature run instead of listing agent runs (Phase 16)',
    )
    .option('--cursor <cursor>', 'Pagination cursor')
    .option('--limit <n>', 'Page size (1-100)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: {
          project?: string;
          featureRun?: string;
          timeline?: string;
          cursor?: string;
          limit?: string;
        } & JsonOption,
      ) => {
        const client = buildApiClient();
        if (opts.timeline) {
          await renderOrJson(
            opts,
            () => client.getFeatureRunTimeline(opts.timeline!),
            (timeline) => renderTimelineView(timeline),
          );
          return;
        }
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
