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
 * `design-doc.ts`'s `request-run` subcommand, so it is not duplicated here. `readiness` is a
 * later addition (not in the original five-route table): `request-readiness-assessment` closes
 * the real gap where nothing in the shipped product ever enqueued
 * `planning-readiness-assessment` after `spec ingest` — its outbox event had no consumer. Each
 * subcommand enqueues a whole task-queue orchestration (not a single synchronous command) and
 * returns `{triggerdevRunId, accepted}` — mirrored by `renderCommandResultView`'s
 * `resultingState` as `enqueued:<runId>` / `not_accepted`, the same shape `design-doc
 * request-run` already uses.
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
    .command('readiness')
    .description(
      "Enqueues planning-readiness-assessment for a project's most recently ingested spec",
    )
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption(
      '--planner-adapter <name>',
      'PlannerAgentAdapter registry name (see `minicoder adapter register`)',
    )
    .option(...IDEMPOTENCY_KEY_OPTION)
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: { project: string; plannerAdapter: string } & IdempotencyKeyOption & JsonOption,
      ) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () =>
            client.requestReadinessAssessment(
              opts.project,
              opts.plannerAdapter,
              resolveIdempotencyKey(`request-readiness-assessment:${opts.project}`, opts),
            ),
          (data) =>
            renderCommandResultView({
              command: 'request-readiness-assessment',
              projectId: opts.project,
              resultingState: data.accepted ? `enqueued:${data.triggerdevRunId}` : 'not_accepted',
            }),
        );
      },
    );

  cmd
    .command('plan-generation')
    .description(
      "Enqueues generate-implementation-plan, invoking the planner adapter against the assessment's specification",
    )
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--assessment <id>', 'Planning readiness assessment ID')
    .requiredOption(
      '--planner-adapter <name>',
      'PlannerAgentAdapter registry name (see `minicoder adapter register`)',
    )
    .option(...IDEMPOTENCY_KEY_OPTION)
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: { project: string; assessment: string; plannerAdapter: string } & IdempotencyKeyOption &
          JsonOption,
      ) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () =>
            client.requestPlanGeneration(
              opts.project,
              opts.assessment,
              opts.plannerAdapter,
              resolveIdempotencyKey(`request-plan-generation:${opts.assessment}`, opts),
            ),
          (data) =>
            renderCommandResultView({
              command: 'request-plan-generation',
              projectId: opts.project,
              resultingState: data.accepted ? `enqueued:${data.triggerdevRunId}` : 'not_accepted',
            }),
        );
      },
    );

  cmd
    .command('backlog-generation')
    .description(
      "Enqueues generate-feature-backlog, invoking the planner adapter against the plan's own sections",
    )
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--plan <id>', 'Implementation plan ID')
    .requiredOption(
      '--planner-adapter <name>',
      'PlannerAgentAdapter registry name (see `minicoder adapter register`)',
    )
    .option(...IDEMPOTENCY_KEY_OPTION)
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: { project: string; plan: string; plannerAdapter: string } & IdempotencyKeyOption &
          JsonOption,
      ) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () =>
            client.requestBacklogGeneration(
              opts.project,
              opts.plan,
              opts.plannerAdapter,
              resolveIdempotencyKey(`request-backlog-generation:${opts.plan}`, opts),
            ),
          (data) =>
            renderCommandResultView({
              command: 'request-backlog-generation',
              projectId: opts.project,
              resultingState: data.accepted ? `enqueued:${data.triggerdevRunId}` : 'not_accepted',
            }),
        );
      },
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
