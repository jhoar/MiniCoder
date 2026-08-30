import { randomUUID } from 'crypto';
import { Command } from 'commander';
import { renderCommandResultView } from '@minicoder/tui/views';
import { buildApiClient, renderOrJson, type JsonOption } from '../tui-client.js';

/**
 * Phase 17 project-lifecycle write actions (docs/00 §5). Mirrors `pause.ts`/`resume.ts`'s exact
 * "GET /status for the current version, mint a fresh per-invocation Idempotency-Key, POST the
 * command" shape — the same reasoning applies here: `MarkImplementationCompleteCommand`/
 * `CompleteProjectCommand` are system-actorKind (reachable via the API's system-key allow-list),
 * one-shot administrative actions with no async/durable-retry need that would justify a
 * Trigger.dev task.
 */
export function createProjectCommand(): Command {
  const cmd = new Command('project').description('Project lifecycle actions (Phase 17)');

  cmd
    .command('mark-implementation-complete')
    .description(
      'active -> implementation_complete, gated by Project Acceptance Validation (system key)',
    )
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption(
      '--evidence <text>',
      'Attestation that the CI-only checks (tests, build, lint, security scan) already passed ' +
        'out-of-band — e.g. a CI run URL or a sign-off note',
    )
    .option('--yes', 'Confirm the transition (required)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; evidence: string; yes?: boolean } & JsonOption) => {
      if (!opts.yes) {
        console.error('Error: --yes is required to confirm marking implementation complete.');
        process.exitCode = 1;
        return;
      }
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const status = await client.getStatus(opts.project);
          if (!status.project) throw new Error(`Project ${opts.project} not found.`);
          const idempotencyKey = `implementation-complete:${opts.project}:${randomUUID()}`;
          const result = await client.markImplementationComplete(
            opts.project,
            status.project.version,
            opts.evidence,
            idempotencyKey,
          );
          return {
            command: 'mark-implementation-complete',
            projectId: opts.project,
            resultingState: result.resulting_state,
          };
        },
        (data) => renderCommandResultView(data),
      );
    });

  cmd
    .command('validate-acceptance')
    .description('Inspects Project Acceptance Validation without transitioning (docs/01 §13.1)')
    .requiredOption('--project <id>', 'Project ID')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string } & JsonOption) => {
      const client = buildApiClient();
      await renderOrJson(
        opts,
        () => client.getProjectAcceptance(opts.project),
        (data) =>
          renderCommandResultView({
            command: 'validate-acceptance',
            projectId: data.projectId,
            resultingState: data.passed ? 'passed' : 'failed',
          }),
      );
    });

  cmd
    .command('complete')
    .description('design_document_approved -> project_complete (system key)')
    .requiredOption('--project <id>', 'Project ID')
    .option('--yes', 'Confirm the transition (required)')
    .option('--json', 'Print raw JSON instead of rendering')
    .action(async (opts: { project: string; yes?: boolean } & JsonOption) => {
      if (!opts.yes) {
        console.error('Error: --yes is required to confirm completing the project.');
        process.exitCode = 1;
        return;
      }
      const client = buildApiClient();
      await renderOrJson(
        opts,
        async () => {
          const status = await client.getStatus(opts.project);
          if (!status.project) throw new Error(`Project ${opts.project} not found.`);
          const idempotencyKey = `complete-project:${opts.project}:${randomUUID()}`;
          const result = await client.completeProject(
            opts.project,
            status.project.version,
            idempotencyKey,
          );
          return {
            command: 'complete-project',
            projectId: opts.project,
            resultingState: result.resulting_state,
          };
        },
        (data) => renderCommandResultView(data),
      );
    });

  return cmd;
}
