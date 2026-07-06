import { Command } from 'commander';
import { createDbClientFromEnv } from '../db-client.js';
import {
  TransactionalCommandExecutor,
  ResolveDisagreementHandler,
  ResumeFeatureExecutionHandler,
  RetryFeatureHandler,
  SkipFeatureHandler,
  BlockFeatureHandler,
  HumanUnblockFeatureHandler,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope } from '@minicoder/core';
import { humanActor } from '@minicoder/triggerdev';

type DbClient = Awaited<ReturnType<typeof createDbClientFromEnv>>;

interface FeatureRunRow {
  id: string;
  version: number;
}

async function fetchFeatureRun(
  db: DbClient,
  featureRunId: string,
  projectId: string,
): Promise<FeatureRunRow> {
  const rows = await db.query<FeatureRunRow>(
    `SELECT fr.id, fr.version
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE fr.id = ? AND freq.project_id = ?`,
    [featureRunId, projectId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`Feature run ${featureRunId} not found in project ${projectId}`);
  }
  return row;
}

interface CommonOpts {
  featureRun: string;
  project: string;
  actor: string;
  actorRole: string;
}

/**
 * Dispatches one of the five `human_required` exit commands (docs/06 Phase 11), plus
 * `human unblock` (issue #53 — `blocked -> approved_pending_execution`, human-triggered), directly
 * against the DB — the same synchronous-command-dispatch shape `minicoder state repair --apply`
 * already uses for guarded destructive operations, rather than going through a Trigger.dev task
 * (there is no natural async/durable-retry need for a one-shot human disposition).
 */
export function createHumanCommand(): Command {
  const human = new Command('human').description(
    'Human disposition commands for feature runs at human_required',
  );

  human
    .command('resolve-disagreement')
    .description('human_required -> changes_requested: resolve an open disagreement, fix required')
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--actor <id>', 'Acting human actor ID')
    .option('--actor-role <role>', 'Actor role (approver|admin)', 'approver')
    .requiredOption('--resolution <text>', 'Resolution notes')
    .option('--disagreement <id>', 'Disagreement record ID (defaults to the most recent open one)')
    .action(async (opts: CommonOpts & { resolution: string; disagreement?: string }) => {
      const db = await createDbClientFromEnv();
      try {
        const run = await fetchFeatureRun(db, opts.featureRun, opts.project);
        const correlationId = generateId();
        const executor = new TransactionalCommandExecutor(db);
        const envelope: CommandEnvelope<Record<string, unknown>> = {
          commandId: generateId(),
          idempotencyKey: `resolve-disagreement:${opts.featureRun}:${run.version}`,
          payload: {
            featureRunId: opts.featureRun,
            projectId: opts.project,
            expectedVersion: run.version,
            resolution: opts.resolution,
            disagreementId: opts.disagreement,
          },
          actor: humanActor({ actorId: opts.actor, actorRole: opts.actorRole, correlationId }),
          correlationId,
        };
        const result = await executor.execute(new ResolveDisagreementHandler(), envelope);
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await db.close();
      }
    });

  human
    .command('resume')
    .description('human_required -> under_review: dismiss the escalation, no fix needed')
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--actor <id>', 'Acting human actor ID')
    .option('--actor-role <role>', 'Actor role (approver|admin)', 'approver')
    .requiredOption('--notes <text>', 'Notes')
    .option('--disagreement <id>', "Disagreement record ID to resolve in the coder's favor")
    .action(async (opts: CommonOpts & { notes: string; disagreement?: string }) => {
      const db = await createDbClientFromEnv();
      try {
        const run = await fetchFeatureRun(db, opts.featureRun, opts.project);
        const correlationId = generateId();
        const executor = new TransactionalCommandExecutor(db);
        const envelope: CommandEnvelope<Record<string, unknown>> = {
          commandId: generateId(),
          idempotencyKey: `resume-feature-execution:${opts.featureRun}:${run.version}`,
          payload: {
            featureRunId: opts.featureRun,
            projectId: opts.project,
            expectedVersion: run.version,
            notes: opts.notes,
            disagreementId: opts.disagreement,
          },
          actor: humanActor({ actorId: opts.actor, actorRole: opts.actorRole, correlationId }),
          correlationId,
        };
        const result = await executor.execute(new ResumeFeatureExecutionHandler(), envelope);
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await db.close();
      }
    });

  human
    .command('retry')
    .description('human_required -> selected: retry automation from the top')
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--actor <id>', 'Acting human actor ID')
    .option('--actor-role <role>', 'Actor role (approver|admin)', 'approver')
    .requiredOption('--notes <text>', 'Notes')
    .action(async (opts: CommonOpts & { notes: string }) => {
      const db = await createDbClientFromEnv();
      try {
        const run = await fetchFeatureRun(db, opts.featureRun, opts.project);
        const correlationId = generateId();
        const executor = new TransactionalCommandExecutor(db);
        const envelope: CommandEnvelope<Record<string, unknown>> = {
          commandId: generateId(),
          idempotencyKey: `retry-feature:${opts.featureRun}:${run.version}`,
          payload: {
            featureRunId: opts.featureRun,
            projectId: opts.project,
            expectedVersion: run.version,
            notes: opts.notes,
          },
          actor: humanActor({ actorId: opts.actor, actorRole: opts.actorRole, correlationId }),
          correlationId,
        };
        const result = await executor.execute(new RetryFeatureHandler(), envelope);
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await db.close();
      }
    });

  human
    .command('skip')
    .description('human_required -> skipped (terminal): abandon automation for this feature')
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--actor <id>', 'Acting human actor ID')
    .option('--actor-role <role>', 'Actor role (approver|admin)', 'approver')
    .requiredOption('--notes <text>', 'Notes')
    .action(async (opts: CommonOpts & { notes: string }) => {
      const db = await createDbClientFromEnv();
      try {
        const run = await fetchFeatureRun(db, opts.featureRun, opts.project);
        const correlationId = generateId();
        const executor = new TransactionalCommandExecutor(db);
        const envelope: CommandEnvelope<Record<string, unknown>> = {
          commandId: generateId(),
          idempotencyKey: `skip-feature:${opts.featureRun}:${run.version}`,
          payload: {
            featureRunId: opts.featureRun,
            projectId: opts.project,
            expectedVersion: run.version,
            notes: opts.notes,
          },
          actor: humanActor({ actorId: opts.actor, actorRole: opts.actorRole, correlationId }),
          correlationId,
        };
        const result = await executor.execute(new SkipFeatureHandler(), envelope);
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await db.close();
      }
    });

  human
    .command('block')
    .description('human_required -> blocked: an external precondition must be satisfied first')
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--actor <id>', 'Acting human actor ID')
    .option('--actor-role <role>', 'Actor role (approver|admin)', 'approver')
    .requiredOption('--notes <text>', 'Notes')
    .action(async (opts: CommonOpts & { notes: string }) => {
      const db = await createDbClientFromEnv();
      try {
        const run = await fetchFeatureRun(db, opts.featureRun, opts.project);
        const correlationId = generateId();
        const executor = new TransactionalCommandExecutor(db);
        const envelope: CommandEnvelope<Record<string, unknown>> = {
          commandId: generateId(),
          idempotencyKey: `block-feature:${opts.featureRun}:${run.version}`,
          payload: {
            featureRunId: opts.featureRun,
            projectId: opts.project,
            expectedVersion: run.version,
            notes: opts.notes,
          },
          actor: humanActor({ actorId: opts.actor, actorRole: opts.actorRole, correlationId }),
          correlationId,
        };
        const result = await executor.execute(new BlockFeatureHandler(), envelope);
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await db.close();
      }
    });

  human
    .command('unblock')
    .description(
      'blocked -> approved_pending_execution: human confirms the precondition is now satisfied (no dependency check)',
    )
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--actor <id>', 'Acting human actor ID')
    .option('--actor-role <role>', 'Actor role (approver|admin)', 'approver')
    .requiredOption('--notes <text>', 'Notes')
    .action(async (opts: CommonOpts & { notes: string }) => {
      const db = await createDbClientFromEnv();
      try {
        const run = await fetchFeatureRun(db, opts.featureRun, opts.project);
        const correlationId = generateId();
        const executor = new TransactionalCommandExecutor(db);
        const envelope: CommandEnvelope<Record<string, unknown>> = {
          commandId: generateId(),
          idempotencyKey: `human-unblock-feature:${opts.featureRun}:${run.version}`,
          payload: {
            featureRunId: opts.featureRun,
            projectId: opts.project,
            expectedVersion: run.version,
            notes: opts.notes,
          },
          actor: humanActor({ actorId: opts.actor, actorRole: opts.actorRole, correlationId }),
          correlationId,
        };
        const result = await executor.execute(new HumanUnblockFeatureHandler(), envelope);
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await db.close();
      }
    });

  return human;
}
