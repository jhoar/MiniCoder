import { Command } from 'commander';
import { createDbClientFromEnv } from '../db-client.js';
import {
  TransactionalCommandExecutor,
  MergeIfReadyHandler,
  RecordMergedHandler,
  RecordMergeFailedHandler,
  ReconcileMergeFailedHandler,
  EscalateToHumanHandler,
  GithubMergeRejectedError,
  CommandError,
  generateId,
  publishMergeGateStatusCheck,
} from '@minicoder/core';
import type { CommandEnvelope, GitHubClient } from '@minicoder/core';
import { humanActor, systemActor, requireNonBlankEnvVar } from '@minicoder/triggerdev';

type DbClient = Awaited<ReturnType<typeof createDbClientFromEnv>>;

interface FeatureRunRow {
  id: string;
  version: number;
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

/**
 * No live GitHubClient is injectable at the CLI boundary — mirrors
 * `github-reconciliation.ts`/`run-coder.ts`'s `resolveDefaultGithubClientFactory` pattern (a
 * GitHub credential is a single deployment-wide secret, not a per-call injected dependency).
 */
async function resolveGithubClient(): Promise<GitHubClient> {
  const token = requireNonBlankEnvVar(
    'GITHUB_TOKEN',
    'minicoder merge merge-if-ready requires a GitHub credential (GitHub App installation token ' +
      'or PAT) to perform the real merge — see docs/07-security-and-secrets.md §3.',
  );
  const { OctokitGitHubClient } = await import('@minicoder/github');
  return new OctokitGitHubClient({ auth: token });
}

/**
 * `minicoder merge merge-if-ready` (docs/06 Phase 12): the only synchronous, approver-initiated
 * CLI action in the merge path — mirrors `minicoder human ...`'s "one-shot dispatch, no
 * Trigger.dev task needed" shape (docs/01 §12: "the actual merge is initiated by an
 * approver/admin via merge-if-ready"). Sequence: (1) `MergeIfReadyCommand` re-evaluates the full
 * merge gate and transitions `approved_by_policy -> merge_ready`; (2) only on that transition's
 * success does this command call the real `GitHubClient.mergePullRequest()`; (3) the GitHub
 * outcome is recorded via `RecordMergedCommand` (success) or `RecordMergeFailedCommand` +
 * `ReconcileMergeFailedCommand`/`EscalateToHumanCommand` (rejection, classified by
 * `GithubMergeRejectedError.autoClearable`). A rejected merge gate (step 1) stops here — no
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
            `SELECT owner, name FROM repositories WHERE project_id = ? LIMIT 1`,
            [opts.project],
          );
          const pr = prRows[0];
          const repo = repoRows[0];
          if (!pr || !repo) {
            throw new Error(
              `Cannot merge feature run ${opts.featureRun}: no tracked pull request or repository`,
            );
          }
          const githubClient = await resolveGithubClient();

          const mergeReadyEnvelope: CommandEnvelope<Record<string, unknown>> = {
            commandId: generateId(),
            idempotencyKey: `merge-ready:${opts.featureRun}`,
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
              await publishMergeGateStatusCheck(githubClient, {
                owner: repo.owner,
                repo: repo.name,
                sha: pr.head_sha,
                decision: 'approved',
                reasons: [],
              });
            }
          } catch (err) {
            if (err instanceof CommandError && err.problem.type === 'merge-gate-blocked') {
              if (pr.head_sha) {
                await publishMergeGateStatusCheck(githubClient, {
                  owner: repo.owner,
                  repo: repo.name,
                  sha: pr.head_sha,
                  decision: 'rejected',
                  reasons: [err.problem.detail],
                });
              }
              console.log(JSON.stringify({ merged: false, reason: err.problem.detail }, null, 2));
              return;
            }
            throw err;
          }

          const system = systemActor(correlationId);
          const mergeReadyRun = await fetchFeatureRun(db, opts.featureRun, opts.project);

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
            if (!(err instanceof GithubMergeRejectedError)) throw err;

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
                idempotencyKey: `escalate-human-merge-failed:${opts.featureRun}`,
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

  return merge;
}
