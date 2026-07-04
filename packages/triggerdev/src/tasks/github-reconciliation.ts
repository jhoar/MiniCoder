import type { DbClient, GitHubClient, FeatureExecutionState } from '@minicoder/core';
import { reconcileGithubState, requiresExecutionLock } from '@minicoder/core';
import { WorkflowLockManager } from '@minicoder/workflow';
import type { GithubReconciliationPayload } from './types.js';
import { isTransientRace as isTransientRaceShared } from './transient-race.js';
import { requireNonBlankEnvVar } from './env.js';

export type { GithubReconciliationPayload };

export interface GithubReconciliationResult {
  projectId: string;
  reconciled: number;
  humanRequired: number;
}

// CommandError `problem.type`s that represent an expected per-candidate concurrency race (a
// webhook-triggered inbox handler ran the same reconciliation transition in-flight under the same
// idempotency key), or an expected non-fatal policy condition. `automation-paused` (code-review
// HIGH-1, round 4): reconcileGithubState()'s CHANGES_REQUESTED branch dispatches
// StartFixingCommand, which throws this when the project's automation is paused/budget-paused —
// a routine, per-candidate condition (this candidate's automation is paused right now), not a
// reason to abort reconciling the rest of the batch.
const EXPECTED_COMMAND_ERROR_TYPES = new Set(['concurrent-command', 'automation-paused']);

/**
 * A transient concurrency loss on a single candidate that a later reconciliation pass will simply
 * retry past — the candidate is skipped without aborting the rest of the batch. See
 * `transient-race.ts`'s `isTransientRace()` doc comment for the shared LockConflictError/
 * OptimisticLockError/StaleFenceError classification; this task also treats `concurrent-command`
 * (an in-flight idempotency-key race with a webhook handler running the same transition) and
 * `automation-paused` (see above) as additional expected races. A genuine infrastructure failure
 * (DB down, GitHub API error, etc.) matches none of these and still throws, correctly failing the
 * task for Trigger.dev retry.
 */
function isTransientRace(err: unknown): boolean {
  return isTransientRaceShared(err, EXPECTED_COMMAND_ERROR_TYPES);
}

export type GithubClientFactory = () => Promise<GitHubClient>;

/**
 * No live GitHubClient is injectable at the Trigger.dev task boundary the way a
 * PlannerAgentAdapter is (see resolveDefaultPlannerAdapter in triggerdev-tasks.ts) — this task
 * constructs an OctokitGitHubClient directly from env, since GitHub credentials (unlike agent
 * adapters) are a single deployment-wide secret, not a per-call injected dependency. Fails fast
 * with an actionable error if GITHUB_TOKEN is unset, matching the "not configured yet" pattern
 * used elsewhere for not-yet-wired dependencies. `requireNonBlankEnvVar` is shared with
 * `run-coder.ts` (LOW-1 code-review fix, round 5) so both GitHub-facing task entrypoints reject
 * whitespace-only `GITHUB_TOKEN` values identically instead of drifting apart.
 */
function resolveDefaultGithubClientFactory(): GithubClientFactory {
  return async () => {
    const token = requireNonBlankEnvVar(
      'GITHUB_TOKEN',
      'github-reconciliation requires a GitHub credential (GitHub App installation token or PAT) ' +
        'to fetch authoritative PR state — see docs/07-security-and-secrets.md §3.',
    );
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

// Terminal / not-yet-possibly-PR states are excluded from the scheduled fallback scan.
// HIGH-2 code-review fix: `code_pushed` is deliberately *not* excluded here (it was previously
// filtered out at the SQL level, before the `candidate.pr_number === null` guard below ever ran).
// A `code_pushed` row can have an already-tracked `pull_requests` row from a fix-cycle re-push
// (`changes_requested -> fixing -> code_pushed`, same PR reused) whose `pr.opened` webhook was
// missed — that candidate must reach `reconcileGithubState` so it can catch up. The
// `candidate.pr_number === null` guard immediately below still `continue`s past a genuinely
// brand-new `code_pushed` row with no tracked PR yet, which remains out of this task's scope
// (discovering never-before-seen PRs requires a "list PRs by branch" GitHubClient method that
// does not exist yet).
const EXCLUDED_STATES = [
  'approved_pending_execution',
  'selected',
  'coding',
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
 * (HIGH-2: this now includes `code_pushed` candidates that already have a tracked `pull_requests`
 * row — a fix-cycle re-push whose `pr.opened` webhook never arrived.)
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
    const observedResult = await client.getPullRequest(repo.owner, repo.name, candidate.pr_number);
    if (!observedResult) continue;
    // Re-bound to a new const so TS's null-narrowing survives capture by the `reconcileWithLock`
    // closure below (narrowing on the original `const` is lost once referenced from a nested
    // function scope).
    const observed: NonNullable<typeof observedResult> = observedResult;

    // MEDIUM-3: only pr_opened/ci_running (execution-lane lock-gated) actions ever need the
    // lock — skip acquire/release entirely when the candidate's current state can never dispatch
    // one of those two commands, instead of acquiring unconditionally on every candidate.
    const needsLock = requiresExecutionLock(
      candidate.current_execution_state as FeatureExecutionState,
    );

    // HIGH-1 code-review fix: was a `function`-keyword declaration nested directly inside this
    // `for` loop's block, which trips ESLint's `no-inner-declarations` (a block-scoped function
    // declaration outside the top level of a function/program body). A `const` arrow function has
    // identical closure semantics here and is not flagged.
    const reconcileWithLock = async (): Promise<
      Awaited<ReturnType<typeof reconcileGithubState>>
    > => {
      const acquired = await lockManager.acquire(
        payload.projectId,
        `execution-lane:${payload.projectId}`,
        { holderId: 'github-reconciliation-task', ttlMs: 30_000 },
      );
      try {
        return await reconcileGithubState({
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
      } finally {
        await lockManager.release(acquired);
      }
    };

    // A per-candidate transient concurrency loss (a concurrent holder of the same
    // `execution-lane:{projectId}` lock — most commonly the start-next-feature task or a
    // webhook-triggered inbox handler running the same reconciliation — a version bump under a
    // Record* command's CAS, a reclaimed lease, or an in-flight idempotency-key race) must skip
    // this candidate, not abort reconciliation of the rest of the batch. The next scheduled
    // fallback (or the webhook that eventually arrives) reconciles it. Wrapping only the
    // reconcile calls — not the getPullRequest fetch above — keeps a genuine GitHub API/DB
    // failure throwing (correctly failing the task for retry).
    try {
      let result: Awaited<ReturnType<typeof reconcileGithubState>>;
      if (!needsLock) {
        result = await reconcileGithubState({
          db,
          featureRunId: candidate.id,
          projectId: payload.projectId,
          observed,
          correlationId: payload.correlationId,
          lockContext: undefined,
        });
        // HIGH-3: the no-lock fast path raced with a concurrent writer (e.g. an overlapping
        // webhook delivery) that advanced this feature run into a lock-gated state after
        // `needsLock` was computed above. Retry once with the lock — its fresh internal state
        // read picks up whatever changed underneath the first call.
        if (result.action === 'lock_required') {
          result = await reconcileWithLock();
        }
      } else {
        result = await reconcileWithLock();
      }
      if (result.action !== 'none') reconciled++;
      if (result.action === 'escalated') humanRequired++;
    } catch (err) {
      if (isTransientRace(err)) continue;
      throw err;
    }
  }

  return { projectId: payload.projectId, reconciled, humanRequired };
}
