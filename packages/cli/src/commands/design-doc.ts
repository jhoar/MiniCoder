import { Command } from 'commander';
import { renderDesignDocView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

export function createDesignDocCommand(): Command {
  return new Command('design-doc')
    .description(
      'Final design document status (read-only — generation/revision/approval ship in Phase 17)',
    )
    .requiredOption('--project <id>', 'Project ID')
    .option('--document <id>', 'Show sections for a specific design document')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; document?: string } & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const [documents, detail] = await Promise.all([
            client.listDesignDocuments(opts.project),
            opts.document ? client.getDesignDocument(opts.document) : Promise.resolve(undefined),
          ]);
          return { documents, detail };
        },
        (data) => renderDesignDocView(data),
      );
    });
}
