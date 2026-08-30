import { Command } from 'commander';
import { renderCostsView, renderBudgetReportView } from '@minicoder/tui/views';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createCostsCommand(): Command {
  return new Command('costs')
    .description('Cost records and budget policies')
    .requiredOption('--project <id>', 'Project ID')
    .option(
      '--report',
      'Show the aggregate spend breakdown by scope/feature/provider/model/role instead of the raw record list (Phase 16)',
    )
    .option('--window-days <n>', 'Restrict --report to the trailing N days')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (opts: { project: string; report?: boolean; windowDays?: string } & JsonOption) => {
        const client = buildApiClient();
        if (opts.report) {
          await renderOrJson(
            opts,
            () =>
              client.getBudgetReport(
                opts.project,
                opts.windowDays !== undefined ? Number(opts.windowDays) : undefined,
              ),
            (report) => renderBudgetReportView(report),
          );
          return;
        }
        await renderOrJson(
          opts,
          async () => {
            const [costs, budgets] = await Promise.all([
              client.listCostRecords(opts.project),
              client.listBudgetPolicies(opts.project),
            ]);
            return { costs, budgets };
          },
          (data) => renderCostsView(data),
        );
      },
    );
}
