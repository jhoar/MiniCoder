import { Command } from 'commander';
import { createDbClientFromEnv } from '../db-client.js';
import {
  TransactionalCommandExecutor,
  MergeIfReadyHandler,
  RecordMergedHandler,
  RecordMergeFailedHandler,
  ReconcileMergeFailedHandler,
  EscalateToHumanHandler,
  ScmMergeRejectedError,
  MergeGateBlockedError,
  FeatureExecutionState,
  generateId,
  publishMergeGateStatusCheck,
} from '@minicoder/core';
import type { CommandEnvelope, ScmClient } from '@minicoder/core';
import { humanActor, systemActor, resolveDefaultScmClient } from '@minicoder/triggerdev';

type DbClient = Awaited<ReturnType<typeof createDbClientFromEnv>>;

interface FeatureRunRow {
  id: string;
  version: number;
  current_execution_state: string;
}

interface PullRequestRow {
  pr_number: number;
  branch_name: string;
  base_branch: string;
  head_sha: string | null;
}

interface RepositoryRow {
  owner: string;
  name: string;
  provider: string;
  base_url: string | null;
}

async function fetchFeatureRun(
  db: DbClient,
  featureRunId: string,
  projectId: string,
): Promise<FeatureRunRow> {
  const rows = await db.query<FeatureRunRow>(
    `SELECT fr.id, fr.version, fr.current_execution_state
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

/**
 * Mirrors `run-merge-gate.ts`'s `publishStatusCheckSafely` — a status-check publish failure is
 * logged and swallowed, never allowed to change the outcome of an already-recorded gate
 * evaluation/state transition (code-review fix: this command used to `await`
 * `publishMergeGateStatusCheck` directly, so a transient commit-status API failure could abort a
 * rejected-gate response, or worse, throw between `MergeIfReadyCommand`'s durable `merge_ready`
 * transition and the real GitHub merge attempt that follows it).
 */
async function publishStatusCheckSafely(
  githubClient: ScmClient,
  opts: Parameters<typeof publishMergeGateStatusCheck>[1],
  featureRunId: string,
): Promise<void> {
  try {
    await publishMergeGateStatusCheck(githubClient, opts);
  } catch (err) {
    console.error(
      `minicoder merge merge-if-ready: failed to publish minicoder/review-gate status check for ${featureRunId}`,
      err,
    );
  }
}

/**
 * `minicoder merge merge-if-ready` (docs/06 Phase 12): the only synchronous, approver-initiated
 * CLI action in the merge path — mirrors `minicoder human ...`'s "one-shot dispatch, no
 * Trigger.dev task needed" shape (docs/01 §12: "the actual merge is initiated by an
 * approver/admin via merge-if-ready"). Sequence: (1) `MergeIfReadyCommand` re-evaluates the full
 * merge gate and transitions `approved_by_policy -> merge_ready`; (2) only on that transition's
 * success does this command call the real `ScmClient.mergePullRequest()`; (3) the GitHub
 * outcome is recorded via `RecordMergedCommand` (success) or `RecordMergeFailedCommand` +
 * `ReconcileMergeFailedCommand`/`EscalateToHumanCommand` (rejection, classified by
 * `ScmMergeRejectedError.autoClearable`). A rejected merge gate (step 1) stops here — no
 * GitHub call is made, and `feature_runs` stays at `approved_by_policy`.
 */
export function createMergeCommand(): Command {
  const merge = new Command('merge').description('Merge Gate commands (docs/06 Phase 12)');

  merge
    .command('merge-if-ready')
    .description('approved_by_policy -> merge_ready -> merged: re-gate then merge via GitHub')
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--actor <id>', 'Acting approver actor ID')
    .option('--actor-role <role>', 'Actor role (approver|admin)', 'approver')
    .option('--merge-method <method>', 'merge|squash|rebase', 'squash')
    .action(
      async (opts: {
        featureRun: string;
        project: string;
        actor: string;
        actorRole: string;
        mergeMethod: 'merge' | 'squash' | 'rebase';
      }) => {
        const db = await createDbClientFromEnv();
        try {
          const correlationId = generateId();
          const executor = new TransactionalCommandExecutor(db);
          const approver = humanActor({
            actorId: opts.actor,
            actorRole: opts.actorRole,
            correlationId,
          });

          const run = await fetchFeatureRun(db, opts.featureRun, opts.project);
          const prRows = await db.query<PullRequestRow>(
            `SELECT pr_number, branch_name, base_branch, head_sha FROM pull_requests WHERE feature_run_id = ?`,
            [opts.featureRun],
          );
          const repoRows = await db.query<RepositoryRow>(
            `SELECT owner, name, provider, base_url FROM repositories WHERE project_id = ? LIMIT 1`,
            [opts.project],
          );
          const pr = prRows[0];
          const repo = repoRows[0];
          if (!pr || !repo) {
            throw new Error(
              `Cannot merge feature run ${opts.featureRun}: no tracked pull request or repository`,
            );
          }
          const githubClient = await resolveDefaultScmClient('minicoder merge')(
            repo.provider,
            repo.base_url,
          );

          const mergeReadyEnvelope: CommandEnvelope<Record<string, unknown>> = {
            commandId: generateId(),
            // {expectedVersion}-scoped (code-review fix): approved_by_policy -> merge_ready can
            // recur for the same feature run across separate merge attempts — a key scoped to
            // featureRunId alone would replay a stale cached result and let this command proceed
            // to the real GitHub merge call without the run actually having re-transitioned.
            idempotencyKey: `merge-ready:${opts.featureRun}:${run.version}`,
            payload: {
              featureRunId: opts.featureRun,
              projectId: opts.project,
              expectedVersion: run.version,
            },
            actor: approver,
            correlationId,
          };
          try {
            await executor.execute(new MergeIfReadyHandler(), mergeReadyEnvelope);
            if (pr.head_sha) {
              await publishStatusCheckSafely(
                githubClient,
                {
                  owner: repo.owner,
                  repo: repo.name,
                  sha: pr.head_sha,
                  decision: 'approved',
                  reasons: [],
                },
                opts.featureRun,
              );
            }
          } catch (err) {
            if (err instanceof MergeGateBlockedError) {
              if (pr.head_sha) {
                await publishStatusCheckSafely(
                  githubClient,
                  {
                    owner: repo.owner,
                    repo: repo.name,
                    sha: pr.head_sha,
                    decision: 'rejected',
                    reasons: err.reasons,
                  },
                  opts.featureRun,
                );
              }
              console.log(JSON.stringify({ merged: false, reasons: err.reasons }, null, 2));
              return;
            }
            throw err;
          }

          const system = systemActor(correlationId);
          const mergeReadyRun = await fetchFeatureRun(db, opts.featureRun, opts.project);
          // Defense-in-depth (code-review fix): re-assert the run is actually merge_ready
          // immediately before the real GitHub merge call, rather than trusting that
          // MergeIfReadyHandler's own transition just above necessarily landed there — this is
          // now redundant with the {expectedVersion}-scoped idempotency key fix above (a stale
          // cache hit can no longer be returned for a different occurrence), but costs nothing to
          // assert explicitly and protects against a future caller reusing this code path
          // differently.
          if (mergeReadyRun.current_execution_state !== FeatureExecutionState.MERGE_READY) {
            throw new Error(
              `Feature run ${opts.featureRun} is not at merge_ready (found ` +
                `'${mergeReadyRun.current_execution_state}'); refusing to call the GitHub merge API`,
            );
          }

          try {
            const { mergeSha } = await githubClient.mergePullRequest({
              owner: repo.owner,
              repo: repo.name,
              prNumber: pr.pr_number,
              mergeMethod: opts.mergeMethod,
              expectedHeadSha: pr.head_sha ?? undefined,
            });
            const recordMergedEnvelope: CommandEnvelope<Record<string, unknown>> = {
              commandId: generateId(),
              idempotencyKey: `record-merged:${opts.featureRun}:${mergeSha}`,
              payload: {
                featureRunId: opts.featureRun,
                projectId: opts.project,
                expectedVersion: mergeReadyRun.version,
                mergeSha,
              },
              actor: system,
              correlationId,
            };
            const result = await executor.execute(new RecordMergedHandler(), recordMergedEnvelope);
            console.log(JSON.stringify({ merged: true, mergeSha, result }, null, 2));
          } catch (err) {
            if (!(err instanceof ScmMergeRejectedError)) throw err;

            const failedEnvelope: CommandEnvelope<Record<string, unknown>> = {
              commandId: generateId(),
              idempotencyKey: `record-merge-failed:${opts.featureRun}:${mergeReadyRun.version}`,
              payload: {
                featureRunId: opts.featureRun,
                projectId: opts.project,
                expectedVersion: mergeReadyRun.version,
                reason: err.message,
                autoClearable: err.autoClearable,
              },
              actor: system,
              correlationId,
            };
            await executor.execute(new RecordMergeFailedHandler(), failedEnvelope);
            const failedRun = await fetchFeatureRun(db, opts.featureRun, opts.project);

            if (err.autoClearable) {
              const reconcileEnvelope: CommandEnvelope<Record<string, unknown>> = {
                commandId: generateId(),
                idempotencyKey: `reconcile-merge-failed:${opts.featureRun}:${failedRun.version}`,
                payload: {
                  featureRunId: opts.featureRun,
                  projectId: opts.project,
                  expectedVersion: failedRun.version,
                },
                actor: system,
                correlationId,
              };
              await executor.execute(new ReconcileMergeFailedHandler(), reconcileEnvelope);
              console.log(
                JSON.stringify(
                  {
                    merged: false,
                    reason: err.message,
                    autoClearable: true,
                    resolution: 'under_review',
                  },
                  null,
                  2,
                ),
              );
            } else {
              const escalateEnvelope: CommandEnvelope<Record<string, unknown>> = {
                commandId: generateId(),
                // {expectedVersion}-scoped (code-review fix): this escalation can recur across
                // separate merge_failed occurrences for the same feature run.
                idempotencyKey: `escalate-human-merge-failed:${opts.featureRun}:${failedRun.version}`,
                payload: {
                  featureRunId: opts.featureRun,
                  projectId: opts.project,
                  expectedVersion: failedRun.version,
                  reason: err.message,
                },
                actor: system,
                correlationId,
              };
              await executor.execute(new EscalateToHumanHandler(), escalateEnvelope);
              console.log(
                JSON.stringify(
                  {
                    merged: false,
                    reason: err.message,
                    autoClearable: false,
                    resolution: 'human_required',
                  },
                  null,
                  2,
                ),
              );
            }
          }
        } finally {
          await db.close();
        }
      },
    );

  merge
    .command('finalize-if-github-merged')
    .description(
      'merge_ready -> merged: recover a feature run stuck after GitHub confirmed the merge but ' +
        'RecordMergedCommand (or a later step) failed to record it (issue #56)',
    )
    .requiredOption('--feature-run <id>', 'Feature run ID')
    .requiredOption('--project <id>', 'Project ID')
    .action(async (opts: { featureRun: string; project: string }) => {
      const db = await createDbClientFromEnv();
      try {
        const correlationId = generateId();
        const executor = new TransactionalCommandExecutor(db);
        const system = systemActor(correlationId);

        const run = await fetchFeatureRun(db, opts.featureRun, opts.project);
        if (run.current_execution_state === FeatureExecutionState.MERGED) {
          console.log(
            JSON.stringify({ alreadyRecorded: true, featureRunId: opts.featureRun }, null, 2),
          );
          return;
        }
        if (run.current_execution_state !== FeatureExecutionState.MERGE_READY) {
          throw new Error(
            `Feature run ${opts.featureRun} is at '${run.current_execution_state}', not ` +
              `merge_ready or merged — this recovery path only applies to a run stuck at ` +
              `merge_ready after a GitHub merge that was never recorded.`,
          );
        }

        const prRows = await db.query<PullRequestRow>(
          `SELECT pr_number, branch_name, base_branch, head_sha FROM pull_requests WHERE feature_run_id = ?`,
          [opts.featureRun],
        );
        const repoRows = await db.query<RepositoryRow>(
          `SELECT owner, name, provider, base_url FROM repositories WHERE project_id = ? LIMIT 1`,
          [opts.project],
        );
        const pr = prRows[0];
        const repo = repoRows[0];
        if (!pr || !repo) {
          throw new Error(
            `Cannot finalize feature run ${opts.featureRun}: no tracked pull request or repository`,
          );
        }

        // Re-verify against GitHub directly rather than trusting the caller's assumption — this
        // command must never record a merge that didn't actually happen.
        const githubClient = await resolveDefaultScmClient('minicoder merge')(
          repo.provider,
          repo.base_url,
        );
        const observed = await githubClient.getPullRequest(repo.owner, repo.name, pr.pr_number);
        if (!observed || observed.state !== 'merged' || !observed.mergedAt) {
          throw new Error(
            `GitHub does not confirm PR #${pr.pr_number} as merged (observed state: ` +
              `'${observed?.state ?? 'not found'}'); refusing to record a merge that did not happen.`,
          );
        }
        const mergeSha = observed.mergeSha ?? observed.headSha;
        if (!mergeSha) {
          throw new Error(
            `GitHub confirms PR #${pr.pr_number} merged but reported no merge/head SHA; cannot record.`,
          );
        }

        const recordMergedEnvelope: CommandEnvelope<Record<string, unknown>> = {
          commandId: generateId(),
          idempotencyKey: `record-merged:${opts.featureRun}:${mergeSha}`,
          payload: {
            featureRunId: opts.featureRun,
            projectId: opts.project,
            expectedVersion: run.version,
            mergeSha,
          },
          actor: system,
          correlationId,
        };
        const result = await executor.execute(new RecordMergedHandler(), recordMergedEnvelope);
        console.log(
          JSON.stringify({ alreadyRecorded: false, merged: true, mergeSha, result }, null, 2),
        );
      } finally {
        await db.close();
      }
    });

  return merge;
}
