import { randomUUID } from 'crypto';
import { Command } from 'commander';
import { renderDesignDocView, renderCommandResultView } from '@minicoder/tui';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

/**
 * Final design document commands (Phase 17). The default (no-subcommand) invocation stays the
 * Phase 14 read-only view; `generate`/`regenerate`/`request-revision`/`approve`/`request-run` are
 * the new write actions this phase adds. Uses the same `isDefault`/`hidden` sibling-subcommand
 * shape `plan.ts` established (see that file's comment) — each subcommand independently declares
 * its own `--project`, avoiding the parent/subcommand option-collision Commander has.
 */
export function createDesignDocCommand(): Command {
  const cmd = new Command('design-doc').description(
    'Final design document status and actions (docs/01 §13; Phase 17 adds write actions)',
  );

  cmd
    .command('view', { isDefault: true, hidden: true })
    .description(
      'Final design document status (read-only — with no subcommand, this is the default view)',
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

  cmd
    .command('generate')
    .description('implementation_complete -> design_document_generating (operator+)')
    .requiredOption('--project <id>', 'Project ID')
    .option('--yes', 'Confirm the transition (required)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; yes?: boolean } & JsonOption) => {
      if (!opts.yes) {
        console.error('Error: --yes is required to confirm generating the design document.');
        process.exitCode = 1;
        return;
      }
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const status = await client.getStatus(opts.project);
          if (!status.project) throw new Error(`Project ${opts.project} not found.`);
          const idempotencyKey = `generate-design-doc:${opts.project}:${randomUUID()}`;
          const result = await client.generateDesignDocument(
            opts.project,
            status.project.version,
            idempotencyKey,
          );
          return {
            command: 'generate-design-document',
            projectId: opts.project,
            resultingState: result.resulting_state,
          };
        },
        (data) => renderCommandResultView(data),
      );
    });

  cmd
    .command('regenerate')
    .description('design_document_revision_requested -> design_document_generating (operator+)')
    .requiredOption('--project <id>', 'Project ID')
    .option('--yes', 'Confirm the transition (required)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; yes?: boolean } & JsonOption) => {
      if (!opts.yes) {
        console.error('Error: --yes is required to confirm regenerating the design document.');
        process.exitCode = 1;
        return;
      }
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const status = await client.getStatus(opts.project);
          if (!status.project) throw new Error(`Project ${opts.project} not found.`);
          const idempotencyKey = `regenerate-design-doc:${opts.project}:${randomUUID()}`;
          const result = await client.regenerateDesignDocument(
            opts.project,
            status.project.version,
            idempotencyKey,
          );
          return {
            command: 'regenerate-design-document',
            projectId: opts.project,
            resultingState: result.resulting_state,
          };
        },
        (data) => renderCommandResultView(data),
      );
    });

  cmd
    .command('request-revision')
    .description(
      'design_document_ready_for_review -> design_document_revision_requested (approver+)',
    )
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--document <id>', 'Design document ID')
    .option('--notes <text>', 'Revision notes')
    .option('--yes', 'Confirm the transition (required)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: { project: string; document: string; notes?: string; yes?: boolean } & JsonOption,
      ) => {
        if (!opts.yes) {
          console.error('Error: --yes is required to confirm requesting a revision.');
          process.exitCode = 1;
          return;
        }
        const client = buildApiClient();
        await renderOrJson(
          opts,
          async () => {
            const status = await client.getStatus(opts.project);
            if (!status.project) throw new Error(`Project ${opts.project} not found.`);
            const idempotencyKey = `request-design-revision:${opts.project}:${randomUUID()}`;
            const result = await client.requestDesignDocumentRevision(
              opts.project,
              status.project.version,
              opts.document,
              opts.notes,
              idempotencyKey,
            );
            return {
              command: 'request-design-document-revision',
              projectId: opts.project,
              resultingState: result.resulting_state,
            };
          },
          (data) => renderCommandResultView(data),
        );
      },
    );

  cmd
    .command('approve')
    .description('design_document_ready_for_review -> design_document_approved (approver+)')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--document <id>', 'Design document ID')
    .option('--notes <text>', 'Approval notes')
    .option('--yes', 'Confirm the transition (required)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: { project: string; document: string; notes?: string; yes?: boolean } & JsonOption,
      ) => {
        if (!opts.yes) {
          console.error('Error: --yes is required to confirm approving the design document.');
          process.exitCode = 1;
          return;
        }
        const client = buildApiClient();
        await renderOrJson(
          opts,
          async () => {
            const status = await client.getStatus(opts.project);
            if (!status.project) throw new Error(`Project ${opts.project} not found.`);
            const idempotencyKey = `approve-design-doc:${opts.project}:${randomUUID()}`;
            const result = await client.approveDesignDocument(
              opts.project,
              status.project.version,
              opts.document,
              opts.notes,
              idempotencyKey,
            );
            return {
              command: 'approve-design-document',
              projectId: opts.project,
              resultingState: result.resulting_state,
            };
          },
          (data) => renderCommandResultView(data),
        );
      },
    );

  cmd
    .command('request-run')
    .description(
      'Enqueues run-design-doc (drafts sections via DocumentationAgentAdapter, exports final-design-document.md)',
    )
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--documentation-adapter <name>', 'DocumentationAgentAdapter registry name')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; documentationAdapter: string } & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        () =>
          client.requestDesignDoc(
            opts.project,
            opts.documentationAdapter,
            `request-design-doc:${opts.project}:${randomUUID()}`,
          ),
        (data) =>
          renderCommandResultView({
            command: 'request-design-doc',
            projectId: opts.project,
            resultingState: data.accepted ? `enqueued:${data.triggerdevRunId}` : 'not_accepted',
          }),
      );
    });

  return cmd;
}
