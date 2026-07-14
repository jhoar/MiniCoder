import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { Command } from 'commander';
import { renderCommandResultView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

/**
 * `IngestSpecificationCommand` (docs/02 §3) — previously reachable only via a hand-built curl
 * call against the generic dispatch route (USER-MANUAL.md §5.0 #1). Insert-only, no state
 * matrix, so there's no `expectedVersion` to fetch first — unlike every other command this file's
 * siblings (`plan.ts`, `budget.ts`) wrap.
 */
export function createSpecCommand(): Command {
  const cmd = new Command('spec').description('Specification ingestion (docs/02 §3)');

  cmd
    .command('ingest <file>')
    .description('Ingest a specification file (operator+)')
    .requiredOption('--project <id>', 'Project ID')
    .option('--content-type <type>', 'MIME type of the specification content', 'text/plain')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (file: string, opts: { project: string; contentType: string } & JsonOption) => {
        const content = fs.readFileSync(file, 'utf-8');
        const client = buildApiClient();
        await renderOrJson(
          opts,
          async () => {
            const idempotencyKey = `ingest-specification:${opts.project}:${randomUUID()}`;
            const result = await client.ingestSpecification(
              opts.project,
              content,
              opts.contentType,
              idempotencyKey,
            );
            return {
              command: 'ingest-specification',
              projectId: opts.project,
              resultingState: result.resulting_state,
            };
          },
          (data) => renderCommandResultView(data),
        );
      },
    );

  return cmd;
}
