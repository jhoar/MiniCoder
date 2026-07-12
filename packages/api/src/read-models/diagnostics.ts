/**
 * State-health / diagnostics read models (docs/01 §9's "state health / diagnostics" read group;
 * docs/00 §5's `minicoder state doctor`/`export-diagnostics` commands). Extracted from
 * `packages/cli/src/commands/state.ts` so the CLI and the Orchestrator API share one
 * implementation instead of two independently-maintained copies of the same SQL.
 *
 * `state repair --apply` is intentionally NOT extracted here — its confirmation-token flow is a
 * local file (`~/.minicoder/pending-repair-token.json`) that does not translate to a stateless
 * HTTP API (see CLAUDE.md's Orchestrator API Operational Constraints).
 */
import type { DbClient, GitHubClient } from '@minicoder/core';
import { FEATURE_EXECUTION_MATRIX, ProjectState, defaultRedactor } from '@minicoder/core';
import type { FeatureExecutionState } from '@minicoder/core';
import { evaluateProjectAcceptance } from '@minicoder/core';
import { branchNameFor } from '@minicoder/adapters-coder';

// Issue #69: every project-lifecycle state reachable only after a project has passed the
// `active -> implementation_complete` acceptance gate at least once. Used by the
// `project_acceptance_violated` doctor check below to find candidate projects worth re-evaluating.
const POST_ACCEPTANCE_PROJECT_STATES: readonly string[] = [
  ProjectState.IMPLEMENTATION_COMPLETE,
  ProjectState.DESIGN_DOCUMENT_GENERATING,
  ProjectState.DESIGN_DOCUMENT_READY_FOR_REVIEW,
  ProjectState.DESIGN_DOCUMENT_REVISION_REQUESTED,
  ProjectState.DESIGN_DOCUMENT_APPROVED,
  ProjectState.PROJECT_COMPLETE,
];

const KNOWN_FEATURE_STATES = new Set<string>(
  FEATURE_EXECUTION_MATRIX.flatMap((row) => [row.fromState, row.toState]),
);

// Orphaned run threshold: 2 hours
const ORPHANED_RUN_THRESHOLD_MS = 2 * 60 * 60 * 1000;
// Triggerdev mismatch threshold: 30 minutes
const TRIGGERDEV_MISMATCH_THRESHOLD_MS = 30 * 60 * 1000;
// Phase 16 (LOW-3 from the Reference Coder Adapter operational-constraints section — previously
// explicitly deferred): grace period before a code_pushed run with no tracked pull_requests row
// is flagged. Deliberately longer than github-reconciliation's own discovery pass interval so a
// routine, still-in-flight PR-creation retry never trips this check.
const PUSHED_NO_PR_THRESHOLD_MS = 30 * 60 * 1000;
// Phase 16 secret-redaction audit check: how many of the most recent agent_context_packs/
// agent_runs rows to sample per call. A bounded sample, not a full-table scan — this is a
// defense-in-depth audit (docs/07 "private chain-of-thought is never stored"), not a replacement
// for AgentRunRecorder's own write-time redaction.
const SECRET_SCAN_SAMPLE_SIZE = 50;

function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function isoNow(): string {
  return new Date().toISOString();
}

export interface ValidationViolation {
  featureRunId: string;
  state: string;
  error: string;
}

export interface ValidationResult {
  checkedRuns: number;
  violations: ValidationViolation[];
  valid: boolean;
}

export async function validateFeatureRunStates(
  db: DbClient,
  projectId?: string,
): Promise<ValidationResult> {
  const whereClause = projectId ? `AND freq.project_id = ?` : '';
  const params = projectId ? [projectId] : [];
  const runs = await db.query<{
    id: string;
    current_execution_state: string;
    feature_request_id: string;
  }>(
    `SELECT fr.id, fr.current_execution_state, fr.feature_request_id
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE fr.ended_at IS NULL ${whereClause}`,
    params,
  );

  const violations: ValidationViolation[] = [];
  for (const run of runs) {
    const st = run.current_execution_state as FeatureExecutionState;
    if (!KNOWN_FEATURE_STATES.has(st)) {
      violations.push({
        featureRunId: run.id,
        state: run.current_execution_state,
        error: `Unknown feature execution state: '${st}'`,
      });
    }
  }
  return { checkedRuns: runs.length, violations, valid: violations.length === 0 };
}

export interface DoctorCheck {
  name: string;
  scope?: 'global';
  severity: 'ok' | 'warning' | 'error';
  autoClearable: boolean;
  manuallyRepairable?: boolean;
  count: number;
  details: unknown[];
}

export interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];
}

export async function runDoctorChecks(db: DbClient, projectId?: string): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const orphanedThreshold = agoIso(ORPHANED_RUN_THRESHOLD_MS);
  const triggerdevThreshold = agoIso(TRIGGERDEV_MISMATCH_THRESHOLD_MS);
  const projectFilter = projectId ? `AND project_id = ?` : '';
  const projectParams = projectId ? [projectId] : [];

  const staleLocks = await db.query<{ id: string; expires_at: string }>(
    `SELECT id, expires_at FROM workflow_locks WHERE expires_at < CURRENT_TIMESTAMP ${projectFilter}`,
    projectParams,
  );
  checks.push({
    name: 'stale_locks',
    severity: staleLocks.length > 0 ? 'error' : 'ok',
    autoClearable: true,
    count: staleLocks.length,
    details: staleLocks.map((l) => ({ id: l.id, expiresAt: l.expires_at })),
  });

  const stuckOutbox = await db.query<{ id: string; event_type: string; attempts: number }>(
    `SELECT id, event_type, attempts FROM outbox_events
     WHERE status IN ('pending', 'processing') AND attempts >= 5`,
    [],
  );
  checks.push({
    name: 'stuck_outbox',
    scope: 'global',
    severity: stuckOutbox.length > 0 ? 'error' : 'ok',
    autoClearable: true,
    count: stuckOutbox.length,
    details: stuckOutbox,
  });

  const stuckInbox = await db.query<{ id: string; event_type: string; attempts: number }>(
    `SELECT id, event_type, attempts FROM inbox_events
     WHERE status IN ('pending', 'processing') AND attempts >= 5`,
    [],
  );
  checks.push({
    name: 'stuck_inbox',
    scope: 'global',
    severity: stuckInbox.length > 0 ? 'error' : 'ok',
    autoClearable: true,
    count: stuckInbox.length,
    details: stuckInbox,
  });

  const orphanedProjectFilter = projectId ? `AND freq.project_id = ?` : '';
  const orphanedParams: unknown[] = [orphanedThreshold];
  if (projectId) orphanedParams.push(projectId);

  const orphanedRuns = await db.query<{
    id: string;
    current_execution_state: string;
    started_at: string;
  }>(
    `SELECT fr.id, fr.current_execution_state, fr.started_at
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE fr.ended_at IS NULL
       AND fr.current_execution_state NOT IN ('merged', 'human_required', 'blocked', 'failed', 'system_failed', 'ci_failed', 'merge_failed')
       AND fr.id NOT IN (SELECT active_feature_run_id FROM workflow_states WHERE active_feature_run_id IS NOT NULL)
       AND fr.started_at < ?
       ${orphanedProjectFilter}`,
    orphanedParams,
  );
  checks.push({
    name: 'orphaned_runs',
    severity: orphanedRuns.length > 0 ? 'error' : 'ok',
    autoClearable: false,
    manuallyRepairable: true,
    count: orphanedRuns.length,
    details: orphanedRuns,
  });

  const tdMismatch = await db.query<{
    id: string;
    triggerdev_task_id: string;
    last_seen_at: string;
  }>(
    `SELECT id, triggerdev_task_id, last_seen_at
     FROM triggerdev_runs
     WHERE triggerdev_status = 'running'
       AND last_seen_at < ?`,
    [triggerdevThreshold],
  );
  checks.push({
    name: 'triggerdev_mismatch',
    scope: 'global',
    severity: tdMismatch.length > 0 ? 'warning' : 'ok',
    autoClearable: false,
    count: tdMismatch.length,
    details: tdMismatch,
  });

  // Issue #52 defense-in-depth: SkipFeatureHandler now cascades a dependent's transition to
  // 'blocked' going forward, but this check still flags any pre-existing case (a feature run
  // stuck at approved_pending_execution depending on an already-skipped feature) that predates the
  // fix, or any future case that somehow slips past it.
  const skippedDepsProjectFilter = projectId ? `AND freq.project_id = ?` : '';
  const skippedDepsParams: unknown[] = projectId ? [projectId] : [];
  const skippedDependencies = await db.query<{
    id: string;
    depends_on_feature_run_id: string;
  }>(
    `SELECT fr.id, dep_fr.id AS depends_on_feature_run_id
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     JOIN feature_dependencies fd ON fd.source_fr_id = fr.feature_request_id
     JOIN feature_runs dep_fr ON dep_fr.feature_request_id = fd.target_fr_id
     WHERE fr.current_execution_state = 'approved_pending_execution'
       AND dep_fr.current_execution_state = 'skipped'
       ${skippedDepsProjectFilter}`,
    skippedDepsParams,
  );
  checks.push({
    name: 'skipped_dependency',
    severity: skippedDependencies.length > 0 ? 'error' : 'ok',
    autoClearable: false,
    manuallyRepairable: true,
    count: skippedDependencies.length,
    details: skippedDependencies,
  });

  // Phase 16 (closes the previously-deferred LOW-3 observability gap): code_pushed feature runs
  // with no linked pull_requests row after a grace period. github-reconciliation's
  // discoverMissingPullRequests() pre-pass already auto-heals most of these; this is the
  // always-on, pure-DB visibility check for whatever slips past it (or hasn't run yet).
  const pushedNoPrThreshold = agoIso(PUSHED_NO_PR_THRESHOLD_MS);
  const pushedNoPrProjectFilter = projectId ? `AND freq.project_id = ?` : '';
  const pushedNoPrParams: unknown[] = [pushedNoPrThreshold];
  if (projectId) pushedNoPrParams.push(projectId);
  const pushedNoPr = await db.query<{ id: string; started_at: string }>(
    `SELECT fr.id, fr.started_at
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     LEFT JOIN pull_requests pr ON pr.feature_run_id = fr.id
     WHERE fr.current_execution_state = 'code_pushed'
       AND pr.id IS NULL
       AND fr.started_at < ?
       ${pushedNoPrProjectFilter}`,
    pushedNoPrParams,
  );
  checks.push({
    name: 'code_pushed_no_pull_request',
    severity: pushedNoPr.length > 0 ? 'warning' : 'ok',
    autoClearable: false,
    manuallyRepairable: true,
    count: pushedNoPr.length,
    details: pushedNoPr,
  });

  // Phase 16 secret-redaction audit (docs/07 "private chain-of-thought is never stored"):
  // defense-in-depth scan of a bounded sample of recently-written agent_context_packs/agent_runs
  // rows for secret-shaped content that should already have been redacted at write time by
  // AgentRunRecorder's SecretRedactor. Reuses that exact same rule set via `scanForSecrets()` —
  // no second pattern library. Read-only/audit: a hit here indicates a redaction-boundary gap
  // worth investigating, it never blocks anything.
  const recentContextPacks = await db.query<{ id: string; agent_run_id: string; content: string }>(
    `SELECT id, agent_run_id, content FROM agent_context_packs ORDER BY created_at DESC, id DESC LIMIT ?`,
    [SECRET_SCAN_SAMPLE_SIZE],
  );
  const recentAgentRuns = await db.query<{
    id: string;
    input_summary: string | null;
    output_summary: string | null;
    error: string | null;
  }>(
    `SELECT id, input_summary, output_summary, error FROM agent_runs ORDER BY created_at DESC, id DESC LIMIT ?`,
    [SECRET_SCAN_SAMPLE_SIZE],
  );
  const secretHits: Array<{ table: string; id: string; field: string; rules: string[] }> = [];
  for (const row of recentContextPacks) {
    const rules = defaultRedactor.scanForSecrets(row.content);
    if (rules.length > 0) {
      secretHits.push({ table: 'agent_context_packs', id: row.id, field: 'content', rules });
    }
  }
  for (const row of recentAgentRuns) {
    for (const field of ['input_summary', 'output_summary', 'error'] as const) {
      const value = row[field];
      if (!value) continue;
      const rules = defaultRedactor.scanForSecrets(value);
      if (rules.length > 0) {
        secretHits.push({ table: 'agent_runs', id: row.id, field, rules });
      }
    }
  }
  checks.push({
    name: 'secret_leak_scan',
    scope: 'global',
    severity: secretHits.length > 0 ? 'error' : 'ok',
    autoClearable: false,
    manuallyRepairable: false,
    count: secretHits.length,
    details: secretHits,
  });

  // Issue #69: `MarkImplementationCompleteHandler`'s `SERIALIZABLE`-isolation fence only protects
  // against concurrent invocations of `MarkImplementationCompleteCommand` itself — every other
  // acceptance-invalidating writer (RecordCiFailedHandler, RecordChangesRequestedHandler, review-
  // finding writers, artifact-export failure handlers, etc.) still runs at the default isolation
  // level and does not participate in that fence. The "accept and monitor" resolution recorded on
  // issue #69 (rather than making every such writer participate in a shared cross-cutting fence,
  // judged out of proportion for a rare, ADMIN-gated, one-time-per-project action): re-run
  // evaluateProjectAcceptance() against every project that has already passed the acceptance gate
  // (any state past `active`) and flag one whose acceptance would now fail — catching a rare
  // violation after the fact rather than trying to make it structurally impossible.
  //
  // PR #73 review fix (round 2, HIGH-1): an earlier revision of this pass bounded this query to
  // the PROJECT_ACCEPTANCE_SWEEP_LIMIT most-recently-updated projects, mirroring
  // secret_leak_scan's bounded-sample posture. That was a real correctness regression, not a
  // proportionate trade-off — unlike secret_leak_scan (a best-effort defense-in-depth audit),
  // this check exists specifically to catch a rare-but-real concurrency violation, and a project
  // outside the sampled window could sit in a permanently-violated state forever while `state
  // doctor` reports healthy. Reverted to an exhaustive, unbounded sweep of every post-acceptance
  // project — correctness here matters more than the theoretical N*M query cost as project count
  // grows (this is a diagnostic endpoint, not a request-latency-sensitive hot path); if that cost
  // ever becomes a real operational problem, the fix is a persisted incremental-coverage cursor
  // (the same shape `observability_export_cursors` already establishes for a similar "make an
  // unbounded periodic sweep resumable" problem), not silent truncation.
  const postAcceptanceProjectFilter = projectId ? `AND id = ?` : '';
  const postAcceptanceProjectParams = projectId ? [projectId] : [];
  const postAcceptanceProjects = await db.query<{ id: string }>(
    `SELECT id FROM projects WHERE state IN (${POST_ACCEPTANCE_PROJECT_STATES.map(() => '?').join(', ')}) ${postAcceptanceProjectFilter}`,
    [...POST_ACCEPTANCE_PROJECT_STATES, ...postAcceptanceProjectParams],
  );
  const acceptanceViolations: Array<{
    projectId: string;
    failedChecks: Array<{ name: string; count: number }>;
  }> = [];
  for (const project of postAcceptanceProjects) {
    const result = await evaluateProjectAcceptance(db, project.id);
    if (!result.passed) {
      acceptanceViolations.push({
        projectId: project.id,
        failedChecks: result.checks
          .filter((c) => !c.passed)
          .map((c) => ({ name: c.name, count: c.count })),
      });
    }
  }
  checks.push({
    name: 'project_acceptance_violated',
    severity: acceptanceViolations.length > 0 ? 'error' : 'ok',
    autoClearable: false,
    manuallyRepairable: false,
    count: acceptanceViolations.length,
    details: acceptanceViolations,
  });

  const hasErrors = checks.some((c) => c.severity === 'error');
  return { healthy: !hasErrors, checks };
}

export interface PrDiscoveryDivergence {
  featureRunId: string;
  branchName: string;
  prNumberOnGithub: number;
}

/**
 * Issue #35: an opt-in doctor check, deliberately NOT part of `runDoctorChecks()` above — every
 * other check there is a pure DB query with no external dependency, while this one needs a live
 * `GitHubClient` credential to ask GitHub directly whether an untracked `code_pushed` feature
 * run's branch already has an open PR. `github-reconciliation`'s scheduled task now auto-heals
 * most of this class of divergence on its own (the same `discoverMissingPullRequests()` query
 * shape this check mirrors), but an operator may want to check for it on demand — without waiting
 * for or depending on that scheduled task having run — via `minicoder state doctor --check-github`.
 */
export async function checkPrDiscoveryDivergence(
  db: DbClient,
  client: GitHubClient,
  projectId?: string,
): Promise<PrDiscoveryDivergence[]> {
  const projectFilter = projectId ? `AND freq.project_id = ?` : '';
  const params = projectId ? [projectId] : [];

  const candidates = await db.query<{
    id: string;
    project_id: string;
    owner: string;
    name: string;
  }>(
    `SELECT fr.id, freq.project_id, repo.owner, repo.name
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     JOIN repositories repo ON repo.project_id = freq.project_id
     LEFT JOIN pull_requests pr ON pr.feature_run_id = fr.id
     WHERE fr.current_execution_state = 'code_pushed' AND pr.id IS NULL ${projectFilter}`,
    params,
  );

  const divergences: PrDiscoveryDivergence[] = [];
  for (const candidate of candidates) {
    const branchName = branchNameFor(candidate.id);
    const matches = await client.listPullRequestsForBranch(
      candidate.owner,
      candidate.name,
      branchName,
      'open',
    );
    const match = matches[0];
    if (match) {
      divergences.push({
        featureRunId: candidate.id,
        branchName,
        prNumberOnGithub: match.prNumber,
      });
    }
  }
  return divergences;
}

export interface ReconcileResult {
  cleared: Array<{ type: string; scope?: 'global'; count: number }>;
}

export async function reconcileState(
  db: DbClient,
  opts: { projectId?: string; all?: boolean },
): Promise<ReconcileResult> {
  const cleared: ReconcileResult['cleared'] = [];
  const projectFilter = opts.projectId ? `AND project_id = ?` : '';
  const projectParams = opts.projectId ? [opts.projectId] : [];

  const staleLockIds = await db.query<{ id: string }>(
    `SELECT id FROM workflow_locks WHERE expires_at < CURRENT_TIMESTAMP ${projectFilter}`,
    projectParams,
  );
  if (staleLockIds.length > 0) {
    await db.execute(
      `UPDATE workflow_locks SET expires_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE expires_at < CURRENT_TIMESTAMP ${projectFilter}`,
      projectParams,
    );
    cleared.push({ type: 'stale_locks', count: staleLockIds.length });
  }

  if (opts.all) {
    const stuckOutboxIds = await db.query<{ id: string }>(
      `SELECT id FROM outbox_events WHERE status IN ('pending', 'processing') AND attempts >= 5`,
      [],
    );
    if (stuckOutboxIds.length > 0) {
      await db.execute(
        `UPDATE outbox_events SET status = 'failed', updated_at = CURRENT_TIMESTAMP
         WHERE status IN ('pending', 'processing') AND attempts >= 5`,
        [],
      );
      cleared.push({ type: 'stuck_outbox', scope: 'global', count: stuckOutboxIds.length });
    }

    const stuckInboxIds = await db.query<{ id: string }>(
      `SELECT id FROM inbox_events WHERE status IN ('pending', 'processing') AND attempts >= 5`,
      [],
    );
    if (stuckInboxIds.length > 0) {
      await db.execute(
        `UPDATE inbox_events SET status = 'failed', updated_at = CURRENT_TIMESTAMP
         WHERE status IN ('pending', 'processing') AND attempts >= 5`,
        [],
      );
      cleared.push({ type: 'stuck_inbox', scope: 'global', count: stuckInboxIds.length });
    }
  }

  return { cleared };
}

export interface DiagnosticsExport {
  exportedAt: string;
  project: { id: string; name: string; state: string } | null;
  workflowEvents: Array<{ event_type: string; created_at: string; project_id: string }>;
  globalOperationalState: {
    scope: 'global';
    pendingOutbox: unknown[];
    pendingInbox: unknown[];
    triggerdevRuns: unknown[];
    workflowLocks: unknown[];
  };
}

export async function exportDiagnostics(
  db: DbClient,
  projectId?: string,
): Promise<DiagnosticsExport> {
  const projectFilter = projectId ? `WHERE project_id = ?` : '';
  const projectParams = projectId ? [projectId] : [];

  const [project, workflowEvents, pendingOutbox, pendingInbox, triggerdevRuns, workflowLocks] =
    await Promise.all([
      projectId
        ? db.query<{ id: string; name: string; state: string }>(
            'SELECT id, name, state FROM projects WHERE id = ?',
            [projectId],
          )
        : Promise.resolve([]),
      db.query<{ event_type: string; created_at: string; project_id: string }>(
        `SELECT event_type, created_at, project_id FROM workflow_events ${projectFilter} ORDER BY created_at DESC LIMIT 50`,
        projectParams,
      ),
      db.query<{ id: string; event_type: string; status: string; attempts: number }>(
        `SELECT id, event_type, status, attempts FROM outbox_events WHERE status IN ('pending', 'processing') LIMIT 100`,
        [],
      ),
      db.query<{ id: string; event_type: string; status: string; attempts: number }>(
        `SELECT id, event_type, status, attempts FROM inbox_events WHERE status IN ('pending', 'processing') LIMIT 100`,
        [],
      ),
      db.query<{
        id: string;
        triggerdev_task_id: string;
        triggerdev_status: string;
        last_seen_at: string;
      }>(
        `SELECT id, triggerdev_task_id, triggerdev_status, last_seen_at FROM triggerdev_runs WHERE triggerdev_status IN ('running', 'failed') ORDER BY created_at DESC LIMIT 50`,
        [],
      ),
      db.query<{ id: string; expires_at: string }>(
        `SELECT id, expires_at FROM workflow_locks ORDER BY expires_at DESC LIMIT 50`,
        [],
      ),
    ]);

  return {
    exportedAt: isoNow(),
    project: project[0] ?? null,
    workflowEvents,
    globalOperationalState: {
      scope: 'global',
      pendingOutbox,
      pendingInbox,
      triggerdevRuns,
      workflowLocks,
    },
  };
}
