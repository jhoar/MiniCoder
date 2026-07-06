import { Command } from 'commander';
import { renderAdaptersView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createAdaptersCommand(): Command {
  return new Command('adapters')
    .description('Registered agent adapters and their configurations')
    .option('--adapter <id>', 'Show configurations for a specific adapter only')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { adapter?: string } & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const [adapters, configurations] = await Promise.all([
            client.listAgentAdapters(),
            client.listAgentConfigurations(opts.adapter),
          ]);
          return { adapters, configurations };
        },
        (data) => renderAdaptersView(data),
      );
    });
}
