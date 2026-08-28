import { Command } from 'commander';
import * as fs from 'fs';
import { createDbClientFromEnv } from '../db-client.js';
import {
  TransactionalCommandExecutor,
  ImportBacklogHandler,
  parseBacklogMarkdown,
  BacklogParseError,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope } from '@minicoder/core';
import { humanActor } from '@minicoder/triggerdev';
import { renderPlanView, renderCommandResultView } from '@minicoder/tui';
import {
  buildApiClient,
  renderOrJson,
  resolveIdempotencyKey,
  type IdempotencyKeyOption,
  type JsonOption,
} from '../tui-client.js';

/** Fetches the plan's current `version` — every write action below needs a live
 * `expectedVersion`. Uses `GET /plans/:id` (a direct lookup), not `listImplementationPlans`'s
 * cursor-paginated listing — scanning only the first page would incorrectly report a valid plan
 * as missing once it's not on page 1 (code-review fix). */
async function fetchPlanVersion(
  client: ReturnType<typeof buildApiClient>,
  projectId: string,
  planId: string,
): Promise<number> {
  const plan = await client.getImplementationPlan(planId);
  if (plan.project_id !== projectId) {
    throw new Error(`Plan ${planId} not found in project ${projectId}`);
  }
  return plan.version;
}

const handler = new ImportBacklogHandler();

export function createPlanCommand(): Command {
  const plan = new Command('plan').description(
    'Plan and backlog artifact commands (Phase 14: with no subcommand, shows the plan/planning-readiness view via the Orchestrator API)',
  );

  // A distinct `isDefault`/`hidden` subcommand, not a `.requiredOption()`/`.action()` on `plan`
  // itself — Commander resolves an option flag shared between a parent Command and one of its
  // subcommands (both declare `--project`) by binding it to the parent, silently starving the
  // subcommand's own `requiredOption` even when the value is present on argv. Two sibling
  // subcommands (this one and `import-backlog`) each independently declaring `--project` do not
  // collide the same way.
  plan
    .command('view', { isDefault: true, hidden: true })
    .description('Default plan/planning-readiness view')
    .requiredOption('--project <id>', 'Project ID')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string } & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const [plans, readiness] = await Promise.all([
            client.listImplementationPlans(opts.project),
            client.listPlanningReadinessAssessments(opts.project),
          ]);
          return { plans, readiness };
        },
        (data) => renderPlanView(data),
      );
    });

  plan
    .command('import-backlog <file>')
    .description(
      'Parse a backlog.md file (issue #33) and import it: parse -> validate -> preview -> approve -> transactional import (docs/02 §11)',
    )
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--plan <id>', 'Implementation plan ID to import features into')
    .requiredOption('--actor <id>', 'Acting approver identity')
    .option('--actor-role <role>', 'Acting role', 'approver')
    .option(
      '--dry-run',
      'Preview only — validates and reports what would be imported, without writing',
    )
    .action(
      async (
        file: string,
        opts: { project: string; plan: string; actor: string; actorRole: string; dryRun?: boolean },
      ) => {
        const markdown = fs.readFileSync(file, 'utf-8');

        let features;
        try {
          features = parseBacklogMarkdown(markdown);
        } catch (err) {
          if (err instanceof BacklogParseError) {
            console.error(`Failed to parse ${file}: ${err.message}`);
            process.exit(1);
          }
          throw err;
        }

        const db = await createDbClientFromEnv();
        try {
          const correlationId = generateId();
          const executor = new TransactionalCommandExecutor(db);
          const envelope: CommandEnvelope<{
            projectId: string;
            planId: string;
            features: typeof features;
            dryRun: boolean;
          }> = {
            commandId: generateId(),
            idempotencyKey: `import-backlog-cli:${opts.plan}:${file}`,
            payload: {
              projectId: opts.project,
              planId: opts.plan,
              features,
              dryRun: opts.dryRun ?? false,
            },
            actor: humanActor({
              actorId: opts.actor,
              actorRole: opts.actorRole,
              correlationId,
            }),
            correlationId,
          };

          const result = await executor.execute(handler, envelope);
          console.log(
            JSON.stringify(
              {
                command: 'plan import-backlog',
                file,
                projectId: opts.project,
                planId: opts.plan,
                featureCount: features.length,
                resultingState: result.resultingState,
              },
              null,
              2,
            ),
          );
        } finally {
          await db.close();
        }
      },
    );

  plan
    .command('submit-for-approval')
    .description('plan-lifecycle draft -> pending_approval (operator+)')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--plan <id>', 'Implementation plan ID')
    .option(
      '--idempotency-key <key>',
      'Reuse a specific Idempotency-Key (for safely retrying after an ambiguous failure)',
    )
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; plan: string } & IdempotencyKeyOption & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const version = await fetchPlanVersion(client, opts.project, opts.plan);
          const idempotencyKey = resolveIdempotencyKey(
            `submit-plan-for-approval:${opts.plan}`,
            opts,
          );
          const result = await client.submitPlanForApproval(
            opts.plan,
            opts.project,
            version,
            idempotencyKey,
          );
          return {
            command: 'submit-plan-for-approval',
            projectId: opts.project,
            resultingState: result.resulting_state,
          };
        },
        (data) => renderCommandResultView(data),
      );
    });

  plan
    .command('approve')
    .description('plan-lifecycle pending_approval -> approved (approver+)')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--plan <id>', 'Implementation plan ID')
    .option('--notes <text>', 'Approval notes')
    .option('--yes', 'Confirm the approval (required)')
    .option(
      '--idempotency-key <key>',
      'Reuse a specific Idempotency-Key (for safely retrying after an ambiguous failure)',
    )
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: {
          project: string;
          plan: string;
          notes?: string;
          yes?: boolean;
        } & IdempotencyKeyOption &
          JsonOption,
      ) => {
        if (!opts.yes) {
          console.error('Error: --yes is required to confirm approving the plan.');
          process.exitCode = 1;
          return;
        }
        const client = buildApiClient();
        await renderOrJson(
          opts,
          async () => {
            const version = await fetchPlanVersion(client, opts.project, opts.plan);
            const idempotencyKey = resolveIdempotencyKey(`approve-plan:${opts.plan}`, opts);
            const result = await client.approvePlan(
              opts.plan,
              opts.project,
              version,
              opts.notes,
              idempotencyKey,
            );
            return {
              command: 'approve-plan',
              projectId: opts.project,
              resultingState: result.resulting_state,
            };
          },
          (data) => renderCommandResultView(data),
        );
      },
    );

  plan
    .command('activate')
    .description('plan-lifecycle approved -> activated_for_execution (approver+)')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--plan <id>', 'Implementation plan ID')
    .option('--yes', 'Confirm the activation (required)')
    .option(
      '--idempotency-key <key>',
      'Reuse a specific Idempotency-Key (for safely retrying after an ambiguous failure)',
    )
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: { project: string; plan: string; yes?: boolean } & IdempotencyKeyOption & JsonOption,
      ) => {
        if (!opts.yes) {
          console.error('Error: --yes is required to confirm activating the plan.');
          process.exitCode = 1;
          return;
        }
        const client = buildApiClient();
        await renderOrJson(
          opts,
          async () => {
            const version = await fetchPlanVersion(client, opts.project, opts.plan);
            const idempotencyKey = resolveIdempotencyKey(`activate-plan:${opts.plan}`, opts);
            const result = await client.activatePlan(
              opts.plan,
              opts.project,
              version,
              idempotencyKey,
            );
            return {
              command: 'activate-plan',
              projectId: opts.project,
              resultingState: result.resulting_state,
            };
          },
          (data) => renderCommandResultView(data),
        );
      },
    );

  plan
    .command('export')
    .description(
      'Render plan.md-equivalent markdown into a new artifact_exports row (operator+, issue #81)',
    )
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--plan <id>', 'Implementation plan ID')
    .option(
      '--idempotency-key <key>',
      'Reuse a specific Idempotency-Key (for safely retrying after an ambiguous failure)',
    )
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; plan: string } & IdempotencyKeyOption & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const idempotencyKey = resolveIdempotencyKey(`export-plan:${opts.plan}`, opts);
          const result = await client.exportPlan(opts.plan, opts.project, idempotencyKey);
          return {
            command: 'export-plan',
            projectId: opts.project,
            resultingState: result.resulting_state,
          };
        },
        (data) => renderCommandResultView(data),
      );
    });

  plan
    .command('export-backlog')
    .description(
      'Render backlog.md-equivalent markdown into a new artifact_exports row (operator+, issue #81)',
    )
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--plan <id>', 'Implementation plan ID')
    .option(
      '--idempotency-key <key>',
      'Reuse a specific Idempotency-Key (for safely retrying after an ambiguous failure)',
    )
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; plan: string } & IdempotencyKeyOption & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const idempotencyKey = resolveIdempotencyKey(`export-backlog:${opts.plan}`, opts);
          const result = await client.exportBacklog(opts.plan, opts.project, idempotencyKey);
          return {
            command: 'export-backlog',
            projectId: opts.project,
            resultingState: result.resulting_state,
          };
        },
        (data) => renderCommandResultView(data),
      );
    });

  return plan;
}
