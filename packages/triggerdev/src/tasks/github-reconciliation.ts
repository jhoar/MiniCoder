import type { DbClient, GitHubClient, FeatureExecutionState } from '@minicoder/core';
import { reconcileGithubState, requiresExecutionLock } from '@minicoder/core';
import { WorkflowLockManager } from '@minicoder/workflow';
import type { GithubReconciliationPayload } from './types.js';

export type { GithubReconciliationPayload };

export interface GithubReconciliationResult {
  projectId: string;
  reconciled: number;
  humanRequired: number;
}

export type GithubClientFactory = () => Promise<GitHubClient>;

/**
 * No live GitHubClient is injectable at the Trigger.dev task boundary the way a
 * PlannerAgentAdapter is (see resolveDefaultPlannerAdapter in triggerdev-tasks.ts) — this task
 * constructs an OctokitGitHubClient directly from env, since GitHub credentials (unlike agent
 * adapters) are a single deployment-wide secret, not a per-call injected dependency. Fails fast
 * with an actionable error if GITHUB_TOKEN is unset, matching the "not configured yet" pattern
 * used elsewhere for not-yet-wired dependencies.
 */
function resolveDefaultGithubClientFactory(): GithubClientFactory {
  return async () => {
    const token = process.env['GITHUB_TOKEN'];
    if (!token) {
      throw new Error(
        'GITHUB_TOKEN is not configured. github-reconciliation requires a GitHub credential ' +
          '(GitHub App installation token or PAT) to fetch authoritative PR state — see ' +
          'docs/07-security-and-secrets.md §3.',
      );
    }
    const { OctokitGitHubClient } = await import('@minicoder/github');
    return new OctokitGitHubClient({ auth: token });
  };
}

interface RepositoryRow {
  owner: string;
  name: string;
}

interface FeatureRunCandidateRow {
  id: string;
  pr_number: number | null;
  current_execution_state: string;
}

// Terminal / not-yet-PR states are excluded from the scheduled fallback scan.
const EXCLUDED_STATES = [
  'approved_pending_execution',
  'selected',
  'coding',
  'code_pushed',
  'merged',
  'human_required',
  'blocked',
  'failed',
  'system_failed',
];

/**
 * Scheduled reconciliation fallback (docs/01 §5.7: "on each relevant webhook (or on the
 * scheduled fallback)"). Reconciles either a single feature run (payload.featureRunId) or every
 * active feature run in the project that already has a tracked pull_requests row — discovering a
 * brand-new PR that has never been observed via a webhook or RecordPrOpenedCommand is out of
 * scope here (GitHubClient has no "list PRs by branch" method yet); this task's job is to catch
 * *missed* webhook deliveries for PRs MiniCoder already knows about, not to discover new ones.
 */
export async function runImpl(
  payload: GithubReconciliationPayload,
  db: DbClient,
  clientFactory: GithubClientFactory = resolveDefaultGithubClientFactory(),
): Promise<GithubReconciliationResult> {
  const repoRows = await db.query<RepositoryRow>(
    `SELECT owner, name FROM repositories WHERE project_id = ? LIMIT 1`,
    [payload.projectId],
  );
  const repo = repoRows[0];
  if (!repo) {
    return { projectId: payload.projectId, reconciled: 0, humanRequired: 0 };
  }

  const candidates = payload.featureRunId
    ? await db.query<FeatureRunCandidateRow>(
        `SELECT fr.id, pr.pr_number, fr.current_execution_state
         FROM feature_runs fr
         JOIN feature_requests freq ON fr.feature_request_id = freq.id
         LEFT JOIN pull_requests pr ON pr.feature_run_id = fr.id
         WHERE fr.id = ? AND freq.project_id = ?`,
        [payload.featureRunId, payload.projectId],
      )
    : await db.query<FeatureRunCandidateRow>(
        `SELECT fr.id, pr.pr_number, fr.current_execution_state
         FROM feature_runs fr
         JOIN feature_requests freq ON fr.feature_request_id = freq.id
         LEFT JOIN pull_requests pr ON pr.feature_run_id = fr.id
         WHERE freq.project_id = ?
           AND fr.current_execution_state NOT IN (${EXCLUDED_STATES.map(() => '?').join(', ')})`,
        [payload.projectId, ...EXCLUDED_STATES],
      );

  const client = await clientFactory();
  const lockManager = new WorkflowLockManager(db);
  let reconciled = 0;
  let humanRequired = 0;

  for (const candidate of candidates) {
    if (candidate.pr_number === null || candidate.pr_number === undefined) continue;
    const observed = await client.getPullRequest(repo.owner, repo.name, candidate.pr_number);
    if (!observed) continue;

    // MEDIUM-3: only pr_opened/ci_running (execution-lane lock-gated) actions ever need the
    // lock — skip acquire/release entirely when the candidate's current state can never dispatch
    // one of those two commands, instead of acquiring unconditionally on every candidate.
    const needsLock = requiresExecutionLock(
      candidate.current_execution_state as FeatureExecutionState,
    );

    if (!needsLock) {
      const result = await reconcileGithubState({
        db,
        featureRunId: candidate.id,
        projectId: payload.projectId,
        observed,
        correlationId: payload.correlationId,
        lockContext: undefined,
      });
      if (result.action !== 'none') reconciled++;
      if (result.action === 'escalated') humanRequired++;
      continue;
    }

    const acquired = await lockManager.acquire(
      payload.projectId,
      `execution-lane:${payload.projectId}`,
      { holderId: 'github-reconciliation-task', ttlMs: 30_000 },
    );
    try {
      const result = await reconcileGithubState({
        db,
        featureRunId: candidate.id,
        projectId: payload.projectId,
        observed,
        correlationId: payload.correlationId,
        lockContext: {
          lockId: acquired.lockId,
          fence: acquired.fence,
          holderId: acquired.holderId,
          projectId: payload.projectId,
          resourceKey: `execution-lane:${payload.projectId}`,
        },
      });
      if (result.action !== 'none') reconciled++;
      if (result.action === 'escalated') humanRequired++;
    } finally {
      await lockManager.release(acquired);
    }
  }

  return { projectId: payload.projectId, reconciled, humanRequired };
}
