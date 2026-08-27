/**
 * `POST /commands/finalize-if-github-merged` (issue #56) — recovers a feature run stuck at
 * `merge_ready` after `githubClient.mergePullRequest()` succeeded but `RecordMergedCommand` (or a
 * later step) failed to record it. See `merge-if-ready-route.ts`'s module doc comment: once the
 * GitHub merge succeeds, the route deliberately leaves its idempotency claim `in-progress` rather
 * than silently retrying the merge — an operator must inspect and resolve the discrepancy
 * directly. This route (and its CLI twin, `minicoder merge finalize-if-github-merged`) is that
 * resolution path: it re-verifies against GitHub before recording anything, so it can never be
 * tricked into recording a merge that didn't actually happen.
 */
import type { FastifyInstance } from 'fastify';
import {
  TransactionalCommandExecutor,
  RecordMergedHandler,
  FeatureExecutionState,
  UserRole,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient, ScmClient } from '@minicoder/core';
import { requireNonBlankEnvVar, systemActor } from '@minicoder/triggerdev';
import { NotFoundError, RequestValidationError } from '../errors.js';
import { requireRole } from '../auth/require-role.js';
import type { GithubClientFactory } from './merge-if-ready-route.js';

async function defaultGithubClientFactory(): Promise<ScmClient> {
  const token = requireNonBlankEnvVar(
    'GITHUB_TOKEN',
    'The Orchestrator API requires a GitHub credential (GitHub App installation token or PAT) to ' +
      'finalize a merge — see docs/07-security-and-secrets.md §3.',
  );
  const { OctokitGitHubClient } = await import('@minicoder/github');
  return new OctokitGitHubClient({ auth: token });
}

interface FeatureRunRow {
  id: string;
  version: number;
  current_execution_state: string;
}

interface PullRequestRow {
  pr_number: number;
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
    `SELECT fr.id, fr.version, fr.current_execution_state
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE fr.id = ? AND freq.project_id = ?`,
    [featureRunId, projectId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('feature-run', featureRunId);
  return row;
}

export interface FinalizeIfGithubMergedDeps {
  db: DbClient;
  githubClientFactory?: GithubClientFactory;
}

interface FinalizeIfGithubMergedBody {
  featureRunId?: string;
  projectId?: string;
}

export function registerFinalizeIfGithubMergedRoute(
  app: FastifyInstance,
  deps: FinalizeIfGithubMergedDeps,
): void {
  const githubClientFactory = deps.githubClientFactory ?? defaultGithubClientFactory;

  app.post<{ Body: FinalizeIfGithubMergedBody }>(
    '/commands/finalize-if-github-merged',
    async (request, reply) => {
      requireRole(request, UserRole.OPERATOR, 'finalize-if-github-merged');
      const { featureRunId, projectId } = request.body ?? {};
      if (!featureRunId || !projectId) {
        throw new RequestValidationError('featureRunId and projectId are required');
      }

      const db = deps.db;
      const correlationId = request.actor!.correlationId;
      const system = systemActor(correlationId);
      const executor = new TransactionalCommandExecutor(db);

      const run = await fetchFeatureRun(db, featureRunId, projectId);
      if (run.current_execution_state === FeatureExecutionState.MERGED) {
        return reply.code(200).send({ alreadyRecorded: true, featureRunId });
      }
      if (run.current_execution_state !== FeatureExecutionState.MERGE_READY) {
        throw new RequestValidationError(
          `Feature run ${featureRunId} is at '${run.current_execution_state}', not merge_ready ` +
            `or merged — this recovery path only applies to a run stuck at merge_ready after a ` +
            `GitHub merge that was never recorded.`,
        );
      }

      const prRows = await db.query<PullRequestRow>(
        `SELECT pr_number FROM pull_requests WHERE feature_run_id = ?`,
        [featureRunId],
      );
      const repoRows = await db.query<RepositoryRow>(
        `SELECT owner, name FROM repositories WHERE project_id = ? LIMIT 1`,
        [projectId],
      );
      const pr = prRows[0];
      const repo = repoRows[0];
      if (!pr || !repo) {
        throw new RequestValidationError(
          `Cannot finalize feature run ${featureRunId}: no tracked pull request or repository`,
        );
      }

      const githubClient = await githubClientFactory();
      const observed = await githubClient.getPullRequest(repo.owner, repo.name, pr.pr_number);
      if (!observed || observed.state !== 'merged' || !observed.mergedAt) {
        throw new RequestValidationError(
          `GitHub does not confirm PR #${pr.pr_number} as merged (observed state: ` +
            `'${observed?.state ?? 'not found'}'); refusing to record a merge that did not happen.`,
        );
      }
      const mergeSha = observed.mergeSha ?? observed.headSha;
      if (!mergeSha) {
        throw new RequestValidationError(
          `GitHub confirms PR #${pr.pr_number} merged but reported no merge/head SHA; cannot record.`,
        );
      }

      const envelope: CommandEnvelope<Record<string, unknown>> = {
        commandId: generateId(),
        idempotencyKey: `record-merged:${featureRunId}:${mergeSha}`,
        payload: {
          featureRunId,
          projectId,
          expectedVersion: run.version,
          mergeSha,
        },
        actor: system,
        correlationId,
      };
      const result = await executor.execute(new RecordMergedHandler(), envelope);
      return reply.code(200).send({ alreadyRecorded: false, merged: true, mergeSha, result });
    },
  );
}
