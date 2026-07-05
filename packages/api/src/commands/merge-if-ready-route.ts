/**
 * `POST /commands/merge-if-ready` — a dedicated route, not generic dispatch, because it chains
 * multiple command dispatches around a real `GitHubClient.mergePullRequest()` call. Mirrors
 * `packages/cli/src/commands/merge.ts`'s `merge-if-ready` sequence exactly: (1) `MergeIfReadyCommand`
 * re-gates and transitions `approved_by_policy -> merge_ready`; (2) only on success, the real
 * GitHub merge call runs; (3) the outcome is recorded via `RecordMergedCommand` (success) or
 * `RecordMergeFailedCommand` + `ReconcileMergeFailedCommand`/`EscalateToHumanCommand` (rejection,
 * classified by `GithubMergeRejectedError.autoClearable`).
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
 * fail rather than replay the original outcome. The whole HTTP response (status + body) for every
 * exit path from `githubClientFactory()` onward is cached against the client-supplied
 * `Idempotency-Key` in `idempotency_keys` (a distinct `merge-if-ready-route` scope, so it can't
 * collide with the per-command sub-keys derived from the same header), and a retry with the same
 * header replays that exact response without touching GitHub or dispatching anything again.
 */
import type { FastifyInstance } from 'fastify';
import {
  TransactionalCommandExecutor,
  MergeIfReadyHandler,
  RecordMergedHandler,
  RecordMergeFailedHandler,
  ReconcileMergeFailedHandler,
  EscalateToHumanHandler,
  GithubMergeRejectedError,
  MergeGateBlockedError,
  FeatureExecutionState,
  generateId,
  isoNow,
  ttlIso,
  publishMergeGateStatusCheck,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient, GitHubClient } from '@minicoder/core';
import { requireNonBlankEnvVar, systemActor } from '@minicoder/triggerdev';
import { MissingIdempotencyKeyError, NotFoundError, RequestValidationError } from '../errors.js';
import { toCommandEnvelopeResponse, type CommandEnvelopeResponse } from './command-response.js';

const ROUTE_IDEMPOTENCY_SCOPE = 'merge-if-ready-route';
const ROUTE_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedRouteResponse {
  status: number;
  body: unknown;
}

async function getCachedRouteResponse(
  db: DbClient,
  key: string,
): Promise<CachedRouteResponse | null> {
  const rows = await db.query<{ result: string }>(
    `SELECT result FROM idempotency_keys WHERE key = ? AND scope = ? AND expires_at > ? AND result IS NOT NULL`,
    [key, ROUTE_IDEMPOTENCY_SCOPE, isoNow()],
  );
  const row = rows[0];
  return row ? (JSON.parse(row.result) as CachedRouteResponse) : null;
}

async function storeRouteResponse(
  db: DbClient,
  key: string,
  response: CachedRouteResponse,
): Promise<void> {
  const now = isoNow();
  try {
    await db.execute(
      `INSERT INTO idempotency_keys (id, key, scope, result, expires_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        generateId(),
        key,
        ROUTE_IDEMPOTENCY_SCOPE,
        JSON.stringify(response),
        ttlIso(ROUTE_IDEMPOTENCY_TTL_MS),
        now,
        now,
      ],
    );
  } catch (err) {
    // UNIQUE(key, scope) conflict: a concurrent/earlier request already cached this route's
    // response — that write wins, this one is a harmless no-op.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/unique/i.test(msg)) throw err;
  }
}

export type GithubClientFactory = () => Promise<GitHubClient>;

async function defaultGithubClientFactory(): Promise<GitHubClient> {
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
  githubClient: GitHubClient,
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

    const cached = await getCachedRouteResponse(db, idempotencyKeyHeader);
    if (cached) {
      return reply.code(cached.status).send(cached.body);
    }
    const respond = async (status: number, body: unknown): Promise<void> => {
      await storeRouteResponse(db, idempotencyKeyHeader, { status, body });
      void reply.code(status).send(body);
    };

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
      if (!(err instanceof GithubMergeRejectedError)) throw err;

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
  });
}
