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
 * Task-enqueue routes (USER-MANUAL.md §5.0.1) that previously had no CLI equivalent —
 * `request-design-doc` is the fifth route in that table but is already wrapped by
 * `design-doc.ts`'s `request-run` subcommand, so it is not duplicated here. Each subcommand
 * enqueues a whole Trigger.dev task orchestration (not a single synchronous command) and returns
 * `{triggerdevRunId, accepted}` — mirrored by `renderCommandResultView`'s `resultingState` as
 * `enqueued:<runId>` / `not_accepted`, the same shape `design-doc request-run` already uses.
 */
const IDEMPOTENCY_KEY_OPTION = [
  '--idempotency-key <key>',
  'Reuse a specific Idempotency-Key (for safely retrying after an ambiguous failure)',
] as const;

export function createRunCommand(): Command {
  const cmd = new Command('run').description(
    'Enqueue coder/reviewer/merge-gate task runs (operator+; docs/01 §9)',
  );

  cmd
    .command('coder')
    .description('Enqueues run-coder for a feature run')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .requiredOption('--coder-adapter <name>', 'CoderAgentAdapter registry name')
    .option(...IDEMPOTENCY_KEY_OPTION)
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: { project: string; featureRun: string; coderAdapter: string } & IdempotencyKeyOption &
          JsonOption,
      ) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () =>
            client.requestCoderRun(
              opts.project,
              opts.featureRun,
              opts.coderAdapter,
              resolveIdempotencyKey(`request-coder-run:${opts.featureRun}`, opts),
            ),
          (data) =>
            renderCommandResultView({
              command: 'request-coder-run',
              projectId: opts.project,
              resultingState: data.accepted ? `enqueued:${data.triggerdevRunId}` : 'not_accepted',
            }),
        );
      },
    );

  cmd
    .command('review')
    .description('Enqueues run-review for a feature run')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .requiredOption('--reviewer-adapter <name>', 'ReviewerAgentAdapter registry name')
    .option('--arbiter-adapter <name>', 'ArbiterAgentAdapter registry name (optional)')
    .option(...IDEMPOTENCY_KEY_OPTION)
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: {
          project: string;
          featureRun: string;
          reviewerAdapter: string;
          arbiterAdapter?: string;
        } & IdempotencyKeyOption &
          JsonOption,
      ) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () =>
            client.requestReview(
              opts.project,
              opts.featureRun,
              opts.reviewerAdapter,
              opts.arbiterAdapter,
              resolveIdempotencyKey(`request-review:${opts.featureRun}`, opts),
            ),
          (data) =>
            renderCommandResultView({
              command: 'request-review',
              projectId: opts.project,
              resultingState: data.accepted ? `enqueued:${data.triggerdevRunId}` : 'not_accepted',
            }),
        );
      },
    );

  cmd
    .command('fixes')
    .description('Enqueues run-review again (there is no separate "fixes" task)')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .requiredOption('--reviewer-adapter <name>', 'ReviewerAgentAdapter registry name')
    .option(...IDEMPOTENCY_KEY_OPTION)
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: {
          project: string;
          featureRun: string;
          reviewerAdapter: string;
        } & IdempotencyKeyOption &
          JsonOption,
      ) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () =>
            client.requestFixes(
              opts.project,
              opts.featureRun,
              opts.reviewerAdapter,
              resolveIdempotencyKey(`request-fixes:${opts.featureRun}`, opts),
            ),
          (data) =>
            renderCommandResultView({
              command: 'request-fixes',
              projectId: opts.project,
              resultingState: data.accepted ? `enqueued:${data.triggerdevRunId}` : 'not_accepted',
            }),
        );
      },
    );

  cmd
    .command('merge-gate')
    .description('Enqueues run-merge-gate for a feature run')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .option(...IDEMPOTENCY_KEY_OPTION)
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (opts: { project: string; featureRun: string } & IdempotencyKeyOption & JsonOption) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () =>
            client.recomputeMergeGate(
              opts.project,
              opts.featureRun,
              resolveIdempotencyKey(`recompute-merge-gate:${opts.featureRun}`, opts),
            ),
          (data) =>
            renderCommandResultView({
              command: 'recompute-merge-gate',
              projectId: opts.project,
              resultingState: data.accepted ? `enqueued:${data.triggerdevRunId}` : 'not_accepted',
            }),
        );
      },
    );

  return cmd;
}
