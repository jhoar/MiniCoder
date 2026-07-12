import type { TxClient } from '../persistence/types.js';

/**
 * Project Acceptance Validation (docs/01 §13.1, Phase 17). This module deliberately does **not**
 * shell out to `pnpm test`/`pnpm build`/lint/security-scan from inside a command handler — that
 * would be a major layering violation (a core domain module invoking the build toolchain) and
 * non-deterministic in unit tests, the same reasoning this codebase already applies to
 * `state doctor` (`packages/api/src/read-models/diagnostics.ts`'s `runDoctorChecks()`, whose shape
 * this module mirrors). `evaluateProjectAcceptance()` only validates what is actually knowable
 * from the database at command-execution time; the CI-only checks (full test suite, migration
 * validation, build, lint/typecheck, security scan) are represented honestly as
 * `externalChecksNotVerified` entries rather than silently assumed to pass. An operator/CI
 * pipeline is expected to have already confirmed those out-of-band before invoking
 * `MarkImplementationCompleteCommand` — the same "honestly-labeled gap" posture CLAUDE.md already
 * applies to issue #61/#66/#67.
 */

export interface ProjectAcceptanceCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly count: number;
  readonly details: unknown[];
}

export interface ProjectAcceptanceResult {
  readonly projectId: string;
  /** True only when every DB-knowable check passed. Does NOT imply the external (CI-only)
   * checks passed — see `externalChecksNotVerified`. */
  readonly passed: boolean;
  readonly checks: ProjectAcceptanceCheck[];
  /** Honest, non-exhaustive-pretending list of checks this function structurally cannot verify
   * from the database alone (docs/01 §13.1's full list minus the DB-knowable subset above). */
  readonly externalChecksNotVerified: string[];
}

const EXTERNAL_CHECKS_NOT_VERIFIED = [
  'full test suite (unit + integration + system scenarios)',
  'migration validation (cross-dialect apply/rollback)',
  'build (typecheck across the ordered package chain)',
  'lint',
  'security scan (pnpm audit/OSV + gitleaks + semgrep)',
];

interface CountRow {
  id: string;
  [key: string]: unknown;
}

/**
 * Evaluates the DB-knowable subset of Project Acceptance Validation for one project:
 *  - every feature run for the project has reached a terminal successful state (`merged` or
 *    `skipped` — matching this codebase's established "skipped never reaches merged" semantics,
 *    so `skipped` counts as accepted-as-terminal, not as a blocker)
 *  - no feature run is currently sitting at `human_required`/`blocked` (an unresolved escalation)
 *  - no unresolved `blocking` review finding remains open against any feature run in the project
 *  - no globally stuck `outbox_events`/`inbox_events` row (attempts >= 5) — reused from
 *    `runDoctorChecks()`'s exact same threshold/shape, global scope since these tables carry no
 *    `project_id` column
 *  - no `artifact_exports` row for this project sitting at `failed`
 *
 * Takes a `TxClient` (not `DbClient`) — it only ever calls `.query()`, never opens its own
 * transaction — so `MarkImplementationCompleteHandler` can call it from inside its own guarding
 * transaction (the same "parameter type widened from `DbClient` to `TxClient`" precedent
 * `evaluateBudget()` already established for an identical reason: evaluating a precondition
 * outside the transaction that acts on it leaves a window for a concurrent write to invalidate
 * the precondition between the check and the state mutation).
 */
export async function evaluateProjectAcceptance(
  db: TxClient,
  projectId: string,
): Promise<ProjectAcceptanceResult> {
  const checks: ProjectAcceptanceCheck[] = [];

  // Starts FROM feature_requests (not feature_runs) so an approved/activatable feature that
  // somehow never got a feature_runs row at all (e.g. activation partially failed) is caught as
  // non-terminal too, not silently invisible to a query that only ever looks at existing runs.
  const nonTerminalFeatures = await db.query<CountRow>(
    `SELECT freq.id, fr.current_execution_state
     FROM feature_requests freq
     LEFT JOIN feature_runs fr ON fr.feature_request_id = freq.id
     WHERE freq.project_id = ? AND freq.kind = 'feature'
       AND (fr.id IS NULL OR fr.current_execution_state NOT IN ('merged', 'skipped'))`,
    [projectId],
  );
  checks.push({
    name: 'all_features_terminal',
    passed: nonTerminalFeatures.length === 0,
    count: nonTerminalFeatures.length,
    details: nonTerminalFeatures,
  });

  const openEscalations = await db.query<CountRow>(
    `SELECT fr.id, fr.current_execution_state
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE freq.project_id = ? AND fr.current_execution_state IN ('human_required', 'blocked')`,
    [projectId],
  );
  checks.push({
    name: 'no_open_human_required_or_blocked',
    passed: openEscalations.length === 0,
    count: openEscalations.length,
    details: openEscalations,
  });

  const unresolvedBlocking = await db.query<CountRow>(
    `SELECT rf.id, rf.feature_run_id, rf.description
     FROM review_findings rf
     JOIN feature_runs fr ON rf.feature_run_id = fr.id
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE freq.project_id = ? AND rf.severity = 'blocking' AND rf.resolved = FALSE`,
    [projectId],
  );
  checks.push({
    name: 'no_unresolved_blocking_findings',
    passed: unresolvedBlocking.length === 0,
    count: unresolvedBlocking.length,
    details: unresolvedBlocking,
  });

  const stuckOutbox = await db.query<CountRow>(
    `SELECT id, event_type FROM outbox_events WHERE status IN ('pending', 'processing') AND attempts >= 5`,
    [],
  );
  const stuckInbox = await db.query<CountRow>(
    `SELECT id, event_type FROM inbox_events WHERE status IN ('pending', 'processing') AND attempts >= 5`,
    [],
  );
  checks.push({
    name: 'no_stuck_outbox_inbox',
    passed: stuckOutbox.length === 0 && stuckInbox.length === 0,
    count: stuckOutbox.length + stuckInbox.length,
    details: [...stuckOutbox, ...stuckInbox],
  });

  const failedExports = await db.query<CountRow>(
    `SELECT id, artifact_type FROM artifact_exports WHERE project_id = ? AND state = 'failed'`,
    [projectId],
  );
  checks.push({
    name: 'no_failed_artifact_exports',
    passed: failedExports.length === 0,
    count: failedExports.length,
    details: failedExports,
  });

  return {
    projectId,
    passed: checks.every((c) => c.passed),
    checks,
    externalChecksNotVerified: [...EXTERNAL_CHECKS_NOT_VERIFIED],
  };
}
