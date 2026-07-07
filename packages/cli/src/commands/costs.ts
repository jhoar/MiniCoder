import { Command } from 'commander';
import { renderCostsView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createCostsCommand(): Command {
  return new Command('costs')
    .description('Cost records and budget policies')
    .requiredOption('--project <id>', 'Project ID')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string } & JsonOption) => {
      const client = buildApiClient();
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
    });
}
