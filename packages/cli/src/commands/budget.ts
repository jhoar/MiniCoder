import { Command } from 'commander';
import { renderCommandResultView } from '@minicoder/tui/views';
import {
  buildApiClient,
  renderOrJson,
  resolveIdempotencyKey,
  type IdempotencyKeyOption,
  type JsonOption,
} from '../tui-client.js';

/**
 * `ApproveBudgetOverrideCommand` (previously curl-only, USER-MANUAL.md §5.0 #6) — serves both
 * `paused_budget_exceeded -> running` and `waiting_for_budget_approval -> running`. Unlike every
 * other command this CLI wraps, it has no single fixed idempotency-key template: the caller must
 * pick the template matching the observed origin automation state (CLAUDE.md's Execution
 * Orchestrator Operational Constraints), so this command reads `GET /status` first to branch.
 */
export function createBudgetCommand(): Command {
  const cmd = new Command('budget').description('Budget gate commands (docs/01 §5.11)');

  cmd
    .command('approve-override')
    .description('paused_budget_exceeded|waiting_for_budget_approval -> running (approver+)')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--policy <id>', 'budget_policies row being overridden')
    .requiredOption('--reason <text>', 'Override reason')
    .option('--yes', 'Confirm the override (required)')
    .option(
      '--idempotency-key <key>',
      'Reuse a specific Idempotency-Key (for safely retrying after an ambiguous failure)',
    )
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: {
          project: string;
          policy: string;
          reason: string;
          yes?: boolean;
        } & IdempotencyKeyOption &
          JsonOption,
      ) => {
        if (!opts.yes) {
          console.error('Error: --yes is required to confirm approving the budget override.');
          process.exitCode = 1;
          return;
        }
        const client = buildApiClient();
        await renderOrJson(
          opts,
          async () => {
            const status = await client.getStatus(opts.project);
            if (!status.workflowState) {
              throw new Error(`Project ${opts.project} has no workflow_states row to override.`);
            }
            const automationState = status.workflowState.automation_state;
            const template =
              automationState === 'waiting_for_budget_approval'
                ? 'budget-override-waiting'
                : 'budget-override';
            if (
              automationState !== 'paused_budget_exceeded' &&
              automationState !== 'waiting_for_budget_approval'
            ) {
              throw new Error(
                `Project ${opts.project} is at automation state '${automationState}', not ` +
                  `paused_budget_exceeded or waiting_for_budget_approval — nothing to override.`,
              );
            }
            const idempotencyKey = resolveIdempotencyKey(
              `${template}:${opts.project}:${status.workflowState.version}`,
              opts,
            );
            const result = await client.approveBudgetOverride(
              opts.project,
              status.workflowState.version,
              opts.reason,
              opts.policy,
              idempotencyKey,
            );
            return {
              command: 'approve-budget-override',
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
