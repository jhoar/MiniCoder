/**
 * `POST /commands/merge-if-ready` — a dedicated route, not generic dispatch, because it chains
 * multiple command dispatches around a real `ScmClient.mergePullRequest()` call. Mirrors
 * `packages/cli/src/commands/merge.ts`'s `merge-if-ready` sequence exactly: (1) `MergeIfReadyCommand`
 * re-gates and transitions `approved_by_policy -> merge_ready`; (2) only on success, the real
 * GitHub merge call runs; (3) the outcome is recorded via `RecordMergedCommand` (success) or
 * `RecordMergeFailedCommand` + `ReconcileMergeFailedCommand`/`EscalateToHumanCommand` (rejection,
 * classified by `ScmMergeRejectedError.autoClearable`).
 *
 * The three follow-up commands dispatched after the real GitHub call
 * (`RecordMergedCommand`/`RecordMergeFailedCommand`/`ReconcileMergeFailedCommand`) all require an
 * `admin`-role `system`-actorKind actor per their own matrix rows — the same `systemActor()`
 * identity `packages/cli/src/commands/merge.ts` and every Trigger.dev task already use for this
 * category of internal follow-up write, not the approver's own role (an approver's role rank is
 * always below admin, so building a "system" actor that merely copies the caller's role would
 * make every one of these three dispatches fail `assertRole` for every real approver).
 *
 * Route-level idempotent replay: this route makes a real external GitHub API call partway
 * through, so unlike a single `CommandHandler`, retrying the same `Idempotency-Key` after a
 * completed request cannot simply re-run the same command dispatches — by the time of a retry the
 * feature run has already moved past `merge_ready` to a terminal state, and re-dispatching would
 * fail rather than replay the original outcome. The whole HTTP response (status + body) is cached
 * against the client-supplied `Idempotency-Key` under a distinct `merge-if-ready-route` scope (so
 * it can't collide with the per-command sub-keys derived from the same header).
 *
 * This is claim-first, not post-hoc: `claimRouteIdempotencyKey()` reserves the `(key, scope)` row
 * via `INSERT ... ON CONFLICT DO NOTHING` *before* any GitHub call or command dispatch. A post-hoc
 * "check cache, do work, store result" approach is not concurrency-safe — two concurrent requests
 * with the same key could both miss the cache and both reach `githubClient.mergePullRequest()`
 * before either response was stored. Claiming first means a second concurrent request sees
 * `in-progress` and gets a retryable `409`, never re-running the side effect. If the claiming
 * request throws before producing a response (a pre-check failure, an infra error), the claim is
 * released rather than left to block every retry until the TTL expires — **except** once
 * `githubClient.mergePullRequest()` has actually succeeded. Past that point the GitHub merge is
 * irreversible; if `RecordMergedHandler` (or anything after it) then throws, releasing the claim
 * would let a same-key retry re-enter this handler, replay the (idempotency-cached, so harmless)
 * `:merge-ready` dispatch, find the run still sitting at `merge_ready`, and call
 * `mergePullRequest()` a second time against an already-merged PR — misrecording a real success as
 * a failure/escalation, not just a wasted retry. `mergeSucceeded` tracks this boundary: once set,
 * the outer catch leaves the claim in its unfulfilled `in-progress` state rather than releasing
 * it, so a retry gets a `409` and an operator must inspect/resolve the discrepancy directly,
 * instead of the API silently repeating an already-completed external action.
 */
import type { FastifyInstance } from 'fastify';
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
import type { CommandEnvelope, DbClient, ScmClient } from '@minicoder/core';
import { requireNonBlankEnvVar, systemActor } from '@minicoder/triggerdev';
import {
  MissingIdempotencyKeyError,
  NotFoundError,
  RequestValidationError,
  RequestInProgressError,
} from '../errors.js';
import { toCommandEnvelopeResponse, type CommandEnvelopeResponse } from './command-response.js';
import {
  claimRouteIdempotencyKey,
  fulfillRouteIdempotencyKey,
  releaseRouteIdempotencyKey,
} from '../route-idempotency.js';

const ROUTE_IDEMPOTENCY_SCOPE = 'merge-if-ready-route';
const ROUTE_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type GithubClientFactory = () => Promise<ScmClient>;

async function defaultGithubClientFactory(): Promise<ScmClient> {
  const token = requireNonBlankEnvVar(
    'GITHUB_TOKEN',
    'The Orchestrator API requires a GitHub credential (GitHub App installation token or PAT) to ' +
      'perform merges — see docs/07-security-and-secrets.md §3.',
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

async function publishStatusCheckSafely(
  githubClient: ScmClient,
  opts: Parameters<typeof publishMergeGateStatusCheck>[1],
  featureRunId: string,
): Promise<void> {
  try {
    await publishMergeGateStatusCheck(githubClient, opts);
  } catch (err) {
    console.error(
      `POST /commands/merge-if-ready: failed to publish minicoder/review-gate status check for ${featureRunId}`,
      err,
    );
  }
}

export interface MergeIfReadyDeps {
  db: DbClient;
  githubClientFactory?: GithubClientFactory;
}

interface MergeIfReadyBody {
  featureRunId?: string;
  projectId?: string;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
}

export function registerMergeIfReadyRoute(app: FastifyInstance, deps: MergeIfReadyDeps): void {
  const githubClientFactory = deps.githubClientFactory ?? defaultGithubClientFactory;

  app.post<{ Body: MergeIfReadyBody }>('/commands/merge-if-ready', async (request, reply) => {
    const { featureRunId, projectId, mergeMethod = 'squash' } = request.body ?? {};
    if (!featureRunId || !projectId) {
      throw new RequestValidationError('featureRunId and projectId are required');
    }
    const idempotencyKeyHeader = request.headers['idempotency-key'];
    if (typeof idempotencyKeyHeader !== 'string' || idempotencyKeyHeader.trim().length === 0) {
      throw new MissingIdempotencyKeyError();
    }

    const db = deps.db;
    const actor = request.actor!;
    const correlationId = actor.correlationId;
    const executor = new TransactionalCommandExecutor(db);

    const claim = await claimRouteIdempotencyKey(
      db,
      idempotencyKeyHeader,
      ROUTE_IDEMPOTENCY_SCOPE,
      ROUTE_IDEMPOTENCY_TTL_MS,
    );
    if (claim.outcome === 'fulfilled') {
      return reply.code(claim.response.status).send(claim.response.body);
    }
    if (claim.outcome === 'in-progress') {
      throw new RequestInProgressError(idempotencyKeyHeader);
    }
    const claimId = claim.claimId;
    const respond = async (status: number, body: unknown): Promise<void> => {
      await fulfillRouteIdempotencyKey(db, claimId, { status, body });
      void reply.code(status).send(body);
    };
    // Set to true only after githubClient.mergePullRequest() actually succeeds — see the module
    // doc comment's "point of no return" note.
    let mergeSucceeded = false;

    try {
      const run = await fetchFeatureRun(db, featureRunId, projectId);
      const prRows = await db.query<PullRequestRow>(
        `SELECT pr_number, branch_name, base_branch, head_sha FROM pull_requests WHERE feature_run_id = ?`,
        [featureRunId],
      );
      const repoRows = await db.query<RepositoryRow>(
        `SELECT owner, name FROM repositories WHERE project_id = ? LIMIT 1`,
        [projectId],
      );
      const pr = prRows[0];
      const repo = repoRows[0];
      if (!pr || !repo) {
        throw new NotFoundError('pull-request-or-repository', featureRunId);
      }
      const githubClient = await githubClientFactory();

      const mergeReadyEnvelope: CommandEnvelope<Record<string, unknown>> = {
        commandId: generateId(),
        idempotencyKey: `${idempotencyKeyHeader}:merge-ready`,
        payload: { featureRunId, projectId, expectedVersion: run.version },
        actor,
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
            featureRunId,
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
              featureRunId,
            );
          }
          await respond(409, { merged: false, reasons: err.reasons });
          return;
        }
        throw err;
      }

      // RecordMergedCommand/RecordMergeFailedCommand/ReconcileMergeFailedCommand all require an
      // admin-role system actor per their own matrix rows — the same identity every Trigger.dev
      // task and packages/cli/src/commands/merge.ts already use, not the approver's own role (see
      // module doc comment above).
      const system = systemActor(correlationId);
      const mergeReadyRun = await fetchFeatureRun(db, featureRunId, projectId);
      if (mergeReadyRun.current_execution_state !== FeatureExecutionState.MERGE_READY) {
        throw new RequestValidationError(
          `Feature run ${featureRunId} is not at merge_ready (found '${mergeReadyRun.current_execution_state}')`,
        );
      }

      try {
        const { mergeSha } = await githubClient.mergePullRequest({
          owner: repo.owner,
          repo: repo.name,
          prNumber: pr.pr_number,
          mergeMethod,
          expectedHeadSha: pr.head_sha ?? undefined,
        });
        mergeSucceeded = true;
        const recordMergedEnvelope: CommandEnvelope<Record<string, unknown>> = {
          commandId: generateId(),
          idempotencyKey: `${idempotencyKeyHeader}:record-merged`,
          payload: { featureRunId, projectId, expectedVersion: mergeReadyRun.version, mergeSha },
          actor: system,
          correlationId,
        };
        const result = await executor.execute(new RecordMergedHandler(), recordMergedEnvelope);
        const body: CommandEnvelopeResponse & { merged: true; mergeSha: string } = {
          ...toCommandEnvelopeResponse(result),
          merged: true,
          mergeSha,
        };
        await respond(200, body);
        return;
      } catch (err) {
        if (!(err instanceof ScmMergeRejectedError)) throw err;

        const failedEnvelope: CommandEnvelope<Record<string, unknown>> = {
          commandId: generateId(),
          idempotencyKey: `${idempotencyKeyHeader}:record-merge-failed`,
          payload: {
            featureRunId,
            projectId,
            expectedVersion: mergeReadyRun.version,
            reason: err.message,
            autoClearable: err.autoClearable,
          },
          actor: system,
          correlationId,
        };
        await executor.execute(new RecordMergeFailedHandler(), failedEnvelope);
        const failedRun = await fetchFeatureRun(db, featureRunId, projectId);

        if (err.autoClearable) {
          const reconcileEnvelope: CommandEnvelope<Record<string, unknown>> = {
            commandId: generateId(),
            idempotencyKey: `${idempotencyKeyHeader}:reconcile-merge-failed`,
            payload: { featureRunId, projectId, expectedVersion: failedRun.version },
            actor: system,
            correlationId,
          };
          await executor.execute(new ReconcileMergeFailedHandler(), reconcileEnvelope);
          await respond(409, {
            merged: false,
            reason: err.message,
            autoClearable: true,
            resolution: 'under_review',
          });
          return;
        }

        const escalateEnvelope: CommandEnvelope<Record<string, unknown>> = {
          commandId: generateId(),
          idempotencyKey: `${idempotencyKeyHeader}:escalate-human-merge-failed`,
          payload: {
            featureRunId,
            projectId,
            expectedVersion: failedRun.version,
            reason: err.message,
          },
          actor: system,
          correlationId,
        };
        await executor.execute(new EscalateToHumanHandler(), escalateEnvelope);
        await respond(409, {
          merged: false,
          reason: err.message,
          autoClearable: false,
          resolution: 'human_required',
        });
        return;
      }
    } catch (err) {
      if (mergeSucceeded) {
        // GitHub has already merged the PR — releasing the claim here would let a retry redo the
        // GitHub call against an already-merged PR (see module doc comment). Leave the claim
        // in its unfulfilled state: a retry gets a 409 in-progress rather than a silent
        // double-merge attempt, and an operator must inspect/resolve this discrepancy directly.
        console.error(
          `POST /commands/merge-if-ready: GitHub merge for feature run ${featureRunId} succeeded ` +
            `but recording it failed after the fact — claim '${idempotencyKeyHeader}' left ` +
            'in-progress for manual operator investigation (see CLAUDE.md).',
          err,
        );
        throw err;
      }
      // The claiming request failed before any irreversible side effect occurred — release the
      // claim so a retry (once whatever caused this is fixed) isn't stuck seeing "in-progress"
      // until the 7-day TTL expires.
      await releaseRouteIdempotencyKey(db, claimId);
      throw err;
    }
  });
}
