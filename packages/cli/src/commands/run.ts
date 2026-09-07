import { randomUUID } from 'crypto';
import { Command } from 'commander';
import { renderCommandResultView } from '@minicoder/tui/views';
import { type ApiClient, ApiError } from '@minicoder/tui/client';
import { FeatureExecutionState } from '@minicoder/core';
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
    .description(
      'Enqueues run-coder for a feature run. Also the fix-cycle trigger (issue #118): ' +
        'run-coder.ts already branches on coding-vs-fixing internally, so re-running this exact ' +
        'command against a feature run currently at `fixing` re-invokes the coder adapter to ' +
        'address open findings — nothing does this automatically yet.',
    )
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

  cmd
    .command('start-next-feature')
    .description(
      'Enqueues start-next-feature: selects the next eligible feature (dependency order, ' +
        'one-feature-at-a-time) and starts coding on it. Omit --feature-run to auto-discover; ' +
        'pass it to target a specific run directly (e.g. retrying one stranded at `selected`).',
    )
    .requiredOption('--project <id>', 'Project ID')
    .option('--feature-run <id>', 'Feature run ID (optional — auto-discovers if omitted)')
    .option(...IDEMPOTENCY_KEY_OPTION)
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: { project: string; featureRun?: string } & IdempotencyKeyOption & JsonOption,
      ) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () =>
            client.requestStartNextFeature(
              opts.project,
              opts.featureRun,
              resolveIdempotencyKey(`request-start-next-feature:${opts.project}`, opts),
            ),
          (data) =>
            renderCommandResultView({
              command: 'request-start-next-feature',
              projectId: opts.project,
              resultingState: data.accepted ? `enqueued:${data.triggerdevRunId}` : 'not_accepted',
            }),
        );
      },
    );

  cmd
    .command('reconciliation')
    .description(
      'Enqueues github-reconciliation on demand — a catch-up pass for a missed/delayed/' +
        'unreachable webhook delivery (issue #119). Omit --feature-run to reconcile every ' +
        'eligible candidate for the project; pass it to scope the pass to a single feature run. ' +
        'Safe to invoke repeatedly.',
    )
    .requiredOption('--project <id>', 'Project ID')
    .option('--feature-run <id>', 'Feature run ID (optional — scopes the pass to one run)')
    .option(...IDEMPOTENCY_KEY_OPTION)
    .option('--json', 'Print raw JSON instead of rendering')
    .action(
      async (
        opts: { project: string; featureRun?: string } & IdempotencyKeyOption & JsonOption,
      ) => {
        const client = buildApiClient();
        await renderOrJson(
          opts,
          () =>
            client.requestReconciliation(
              opts.project,
              opts.featureRun,
              resolveIdempotencyKey(`request-reconciliation:${opts.project}`, opts),
            ),
          (data) =>
            renderCommandResultView({
              command: 'request-reconciliation',
              projectId: opts.project,
              resultingState: data.accepted ? `enqueued:${data.triggerdevRunId}` : 'not_accepted',
            }),
        );
      },
    );

  cmd
    .command('feature')
    .description(
      'Drives one feature run to completion unattended (issue #123): polls its state and ' +
        'issues the next enqueue/command call as each hop is reached, stopping on merged/' +
        'skipped/human_required/blocked/a terminal failure, or a state that needs a human ' +
        'decision (fail-safe — never guesses past a blocker). Requires --watch. Assumes ' +
        '`minicoder tasks worker` is already running elsewhere against the same database — ' +
        'this command only enqueues work, it never executes a task itself.',
    )
    .requiredOption('--project <id>', 'Project ID')
    .option(
      '--feature-run <id>',
      'Feature run ID to drive (omit to auto-discover the next eligible feature via start-next-feature)',
    )
    .requiredOption('--coder-adapter <name>', 'CoderAgentAdapter registry name')
    .requiredOption('--reviewer-adapter <name>', 'ReviewerAgentAdapter registry name')
    .option('--arbiter-adapter <name>', 'ArbiterAgentAdapter registry name (optional)')
    .option(
      '--merge-method <method>',
      'merge|squash|rebase for the final GitHub merge (defaults to the API route\'s own default)',
    )
    .option(
      '--no-merge',
      'Stop at approved_by_policy instead of attempting the real merge (e.g. when using an ' +
        'operator-only API key that lacks approver role) — run `minicoder merge merge-if-ready` ' +
        'manually to finish',
    )
    .requiredOption('--watch', 'Required — confirms this is the long-running polling mode')
    .option(
      '--poll-interval-ms <ms>',
      'Milliseconds between poll ticks',
      (v) => parseInt(v, 10),
      5000,
    )
    .option(
      '--stuck-retry-ms <ms>',
      'Re-issue a coding/fixing/selection action if stuck in the same state this long (covers ' +
        'a task that silently failed, or no worker having been running yet)',
      (v) => parseInt(v, 10),
      60_000,
    )
    .option(
      '--timeout-ms <ms>',
      'Give up and exit non-zero if the feature has not reached a terminal/paused state by then',
      (v) => parseInt(v, 10),
      1_800_000,
    )
    .action(async (opts: WatchFeatureOptions) => {
      const client = buildApiClient();
      await watchFeature(client, opts);
    });

  return cmd;
}

interface WatchFeatureOptions {
  project: string;
  featureRun?: string;
  coderAdapter: string;
  reviewerAdapter: string;
  arbiterAdapter?: string;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  merge: boolean;
  pollIntervalMs: number;
  stuckRetryMs: number;
  timeoutMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ command: 'run feature --watch', ...event }));
}

/** Every non-terminal state's action is safe to re-issue — either the underlying command is a
 * pure re-gate/no-op when not applicable (recompute-merge-gate, merge-if-ready, reconciliation)
 * or the review-occurrence-marker/idempotency machinery already covers a repeat call
 * (run-review). `under_review` and `approved_by_policy` are re-issued on *every* tick
 * deliberately: a clean review leaves the feature run at `under_review` with no state change at
 * all (Phase 12's Merge Gate owns that follow-up, CLAUDE.md's Reference Reviewer Adapter
 * Operational Constraints) — waiting for a state change before re-acting would hang forever, so
 * these two states can't use the "act once, then wait for a stuck timeout" policy every other
 * state uses. */
const ALWAYS_REISSUE_STATES: ReadonlySet<string> = new Set([
  FeatureExecutionState.CODE_PUSHED,
  FeatureExecutionState.PR_OPENED,
  FeatureExecutionState.CI_RUNNING,
  FeatureExecutionState.CHANGES_REQUESTED,
  FeatureExecutionState.CI_FAILED,
  FeatureExecutionState.MERGE_FAILED,
  FeatureExecutionState.UNDER_REVIEW,
  FeatureExecutionState.APPROVED_BY_POLICY,
]);

const TERMINAL_SUCCESS_STATES: ReadonlySet<string> = new Set([
  FeatureExecutionState.MERGED,
  FeatureExecutionState.SKIPPED,
]);

const TERMINAL_BLOCKED_STATES: ReadonlySet<string> = new Set([
  FeatureExecutionState.HUMAN_REQUIRED,
  FeatureExecutionState.BLOCKED,
  FeatureExecutionState.FAILED,
  FeatureExecutionState.SYSTEM_FAILED,
]);

function freshKey(prefix: string): string {
  return `watch-${prefix}-${randomUUID()}`;
}

/**
 * Issues the one enqueue/command call appropriate for `state`. Returns a short label describing
 * what it did, for the per-tick log line. Never throws for an *expected* non-2xx outcome (a
 * blocked merge gate, a merge rejection) — those are logged and left for the next tick/state
 * change to react to; only a genuinely unexpected error propagates to the caller's catch.
 */
async function actOnState(
  client: ApiClient,
  opts: WatchFeatureOptions,
  featureRunId: string,
  state: string,
): Promise<string> {
  switch (state) {
    case FeatureExecutionState.APPROVED_PENDING_EXECUTION:
    case FeatureExecutionState.SELECTED: {
      await client.requestStartNextFeature(opts.project, featureRunId, freshKey('start'));
      return 'requested start-next-feature (select/start-coding)';
    }
    case FeatureExecutionState.CODING:
    case FeatureExecutionState.FIXING: {
      await client.requestCoderRun(
        opts.project,
        featureRunId,
        opts.coderAdapter,
        freshKey('coder'),
      );
      return `requested run-coder (${state})`;
    }
    case FeatureExecutionState.CODE_PUSHED:
    case FeatureExecutionState.PR_OPENED:
    case FeatureExecutionState.CI_RUNNING:
    case FeatureExecutionState.CHANGES_REQUESTED:
    case FeatureExecutionState.CI_FAILED:
    case FeatureExecutionState.MERGE_FAILED: {
      await client.requestReconciliation(opts.project, featureRunId, freshKey('reconcile'));
      return 'requested github-reconciliation catch-up';
    }
    case FeatureExecutionState.UNDER_REVIEW: {
      // Both calls are safe no-ops when not yet applicable — see ALWAYS_REISSUE_STATES' doc
      // comment for why this state needs both fired every tick rather than once each.
      await client.requestReview(
        opts.project,
        featureRunId,
        opts.reviewerAdapter,
        opts.arbiterAdapter,
        freshKey('review'),
      );
      await client.recomputeMergeGate(opts.project, featureRunId, freshKey('merge-gate'));
      return 'requested run-review + recompute-merge-gate';
    }
    case FeatureExecutionState.APPROVED_BY_POLICY: {
      if (!opts.merge) {
        return 'reached approved_by_policy; --no-merge set, not attempting the real merge';
      }
      const result = await client.mergeIfReady(
        opts.project,
        featureRunId,
        freshKey('merge'),
        opts.mergeMethod,
      );
      if (result.merged) return `merged (sha ${result.mergeSha})`;
      if ('reasons' in result) return `merge gate still blocked: ${result.reasons.join('; ')}`;
      return `merge rejected (${result.resolution}): ${result.reason}`;
    }
    default:
      return `no action defined for state '${state}'`;
  }
}

/**
 * The `--watch` loop itself (issue #123). Deliberately a CLI-level poll loop, not a new Workflow
 * Layer task — see issue #118's resolution: nothing in this codebase auto-chains Workflow Layer
 * tasks (not even the initial `coding` invocation), so building this as backend auto-chaining
 * would be architecturally inconsistent and would need an unplanned "default adapter for this
 * role" concept this codebase doesn't have. Instead this command carries the adapter names for
 * the loop's whole lifetime (the same information a human currently has to remember across manual
 * steps) and simply calls the already-existing enqueue routes in sequence as state changes.
 */
async function watchFeature(client: ApiClient, opts: WatchFeatureOptions): Promise<void> {
  let interrupted = false;
  const sigintHandler = (): void => {
    interrupted = true;
    log({ status: 'interrupted', signal: 'SIGINT' });
  };
  const sigtermHandler = (): void => {
    interrupted = true;
    log({ status: 'interrupted', signal: 'SIGTERM' });
  };
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);
  try {
    await runWatchLoop(client, opts, () => interrupted);
  } finally {
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
  }
}

async function runWatchLoop(
  client: ApiClient,
  opts: WatchFeatureOptions,
  isInterrupted: () => boolean,
): Promise<void> {
  let featureRunId = opts.featureRun ?? null;
  let lastObservedState: string | null = null;
  let stateEnteredAt = Date.now();
  const deadline = Date.now() + opts.timeoutMs;

  while (!isInterrupted()) {
    if (Date.now() > deadline) {
      log({ status: 'timeout', featureRunId, lastObservedState });
      process.exitCode = 3;
      return;
    }

    if (!featureRunId) {
      const { activeFeatureRun } = await client.getActiveFeature(opts.project);
      if (activeFeatureRun) {
        featureRunId = activeFeatureRun.id;
        log({ status: 'selected', featureRunId });
        continue;
      }
      if (lastObservedState !== 'discovering') {
        await client.requestStartNextFeature(opts.project, undefined, freshKey('discover'));
        lastObservedState = 'discovering';
        log({ status: 'discovering', note: 'requested start-next-feature (auto-discovery)' });
      }
      await sleep(opts.pollIntervalMs);
      continue;
    }

    let run;
    try {
      run = await client.getFeatureRun(featureRunId);
    } catch (err) {
      log({
        status: 'error',
        featureRunId,
        detail: err instanceof ApiError ? err.problem.detail : String(err),
      });
      process.exitCode = 1;
      return;
    }
    const state = run.current_execution_state;

    if (TERMINAL_SUCCESS_STATES.has(state)) {
      log({ status: 'done', featureRunId, resultingState: state });
      process.exitCode = 0;
      return;
    }
    if (TERMINAL_BLOCKED_STATES.has(state)) {
      log({
        status: 'stopped',
        featureRunId,
        resultingState: state,
        note: 'needs a human decision (minicoder human ...) — the loop never guesses past this',
      });
      process.exitCode = 1;
      return;
    }
    if (state === FeatureExecutionState.MERGE_READY) {
      // Only reachable if a prior process crashed between MergeIfReadyCommand's transition and
      // the real GitHub merge call — merge-if-ready itself advances approved_by_policy all the
      // way to merged (or a clean 409) in one request. Recovering this exact window is
      // `minicoder merge finalize-if-github-merged`'s job, not this loop's — see CLAUDE.md's
      // Orchestrator API Operational Constraints, issue #56.
      log({
        status: 'stopped',
        featureRunId,
        resultingState: state,
        note: 'stuck at merge_ready — run `minicoder merge finalize-if-github-merged` to recover',
      });
      process.exitCode = 2;
      return;
    }

    const stateChanged = state !== lastObservedState;
    if (stateChanged) {
      lastObservedState = state;
      stateEnteredAt = Date.now();
    }
    const stuckLongEnough = Date.now() - stateEnteredAt >= opts.stuckRetryMs;
    const shouldAct = stateChanged || ALWAYS_REISSUE_STATES.has(state) || stuckLongEnough;

    if (shouldAct) {
      try {
        const action = await actOnState(client, opts, featureRunId, state);
        log({ status: 'progress', featureRunId, state, action });
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          log({
            status: 'stopped',
            featureRunId,
            state,
            note:
              'the configured API key lacks the role needed for this hop; use a higher-role ' +
              'key, or (at approved_by_policy) pass --no-merge and finish manually',
            detail: err.problem.detail,
          });
          process.exitCode = 2;
          return;
        }
        log({
          status: 'error',
          featureRunId,
          state,
          detail: err instanceof ApiError ? err.problem.detail : String(err),
        });
        process.exitCode = 1;
        return;
      }
    }

    if (!opts.merge && state === FeatureExecutionState.APPROVED_BY_POLICY) {
      process.exitCode = 2;
      return;
    }

    await sleep(opts.pollIntervalMs);
  }
}
