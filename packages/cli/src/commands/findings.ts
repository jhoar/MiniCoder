import { Command } from 'commander';
import { renderFindingsView, renderCommandResultView } from '@minicoder/tui/views';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

/**
 * Issue #116 added a `resolve` write action alongside the pre-existing read-only listing. Uses
 * the same `isDefault`/`hidden` sibling-subcommand shape `plan.ts`/`design-doc.ts` established
 * (see those files' comments) — each subcommand independently declares its own flags, avoiding
 * the parent/subcommand option-collision Commander has when the same flag is declared on both.
 */
export function createFindingsCommand(): Command {
  const cmd = new Command('findings').description(
    'Review findings for a feature run (with no subcommand, this lists them)',
  );

  cmd
    .command('view', { isDefault: true, hidden: true })
    .description('List review findings for a feature run (read-only)')
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

  cmd
    .command('resolve')
    .description(
      'Record a human disposition for a non-blocking finding (issue #116; operator+). ' +
        'Without --dismiss, records "looked at, still wants it addressed" and leaves resolved ' +
        'unchanged; with --dismiss, also marks the finding resolved.',
    )
    .requiredOption('--finding-id <id>', 'review_findings row ID')
    .option('--dismiss', 'Also mark the finding resolved (not worth fixing)')
    .option('--note <text>', 'Optional note explaining the disposition')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (opts: { findingId: string; dismiss?: boolean; note?: string } & JsonOption) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () => client.resolveReviewFinding(opts.findingId, Boolean(opts.dismiss), opts.note),
          (data) =>
            renderCommandResultView({
              command: 'findings resolve',
              resultingState: data.dismissed ? 'dismissed' : 'acknowledged',
            }),
        );
      },
    );

  return cmd;
}
