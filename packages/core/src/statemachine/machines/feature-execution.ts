import { FeatureExecutionState, UserRole } from '../../domain/states.js';
import type { StateMatrix } from '../types.js';

export const FEATURE_EXECUTION_MATRIX: StateMatrix<FeatureExecutionState> = [
  // ── Main flow ──────────────────────────────────────────────────────────────
  {
    fromState: FeatureExecutionState.APPROVED_PENDING_EXECUTION,
    toState: FeatureExecutionState.SELECTED,
    triggeringCommand: 'SelectFeatureCommand',
    actor: UserRole.OPERATOR,
    guardDescription:
      'automationState=running; no other active feature run for project; all feature dependencies merged',
    sideEffects: ['set_active_feature_run', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.selected'],
    idempotencyKeyTemplate: 'select-feature:{featureRunId}',
    recoveryPath:
      'Lock expires; reconciliation clears active_feature_run_id; feature returns to approved_pending_execution',
  },
  {
    fromState: FeatureExecutionState.SELECTED,
    toState: FeatureExecutionState.CODING,
    triggeringCommand: 'StartCodingCommand',
    actor: 'system',
    guardDescription:
      'workflow lock held with valid fence; feature run id matches active_feature_run_id',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.coding_started'],
    idempotencyKeyTemplate: 'start-coding:{featureRunId}',
    recoveryPath: 'Idempotent replay returns cached result; lock prevents concurrent start',
  },
  {
    fromState: FeatureExecutionState.CODING,
    toState: FeatureExecutionState.CODE_PUSHED,
    triggeringCommand: 'RecordCodePushedCommand',
    actor: 'system',
    guardDescription: 'workflow lock held with valid fence; commit sha provided',
    sideEffects: ['record_commit_sha', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.code_pushed'],
    idempotencyKeyTemplate: 'record-code-pushed:{featureRunId}:{commitSha}',
    recoveryPath: 'Idempotent: same commitSha returns cached result',
  },
  {
    fromState: FeatureExecutionState.CODE_PUSHED,
    toState: FeatureExecutionState.PR_OPENED,
    triggeringCommand: 'RecordPrOpenedCommand',
    actor: 'system',
    guardDescription: 'workflow lock held; pull request number provided',
    sideEffects: ['record_pr_number', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.pr_opened'],
    idempotencyKeyTemplate: 'record-pr-opened:{featureRunId}:{prNumber}',
    recoveryPath: 'Idempotent: same prNumber returns cached result',
  },
  {
    fromState: FeatureExecutionState.PR_OPENED,
    toState: FeatureExecutionState.CI_RUNNING,
    triggeringCommand: 'RecordCiRunningCommand',
    actor: 'system',
    guardDescription: 'workflow lock held; CI check run id provided',
    sideEffects: ['record_ci_run_id', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.ci_running'],
    idempotencyKeyTemplate: 'record-ci-running:{featureRunId}:{checkRunId}',
    recoveryPath: 'Idempotent: same checkRunId returns cached result',
  },
  // ── GitHub reconciliation divergence (Phase 7) ───────────────────────────────
  {
    fromState: FeatureExecutionState.PR_OPENED,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription:
      'GitHub reconciliation observed the pull request closed without merging while the feature run was pr_opened — irreconcilable divergence (docs/01 §5.7)',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-github:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  {
    fromState: FeatureExecutionState.CI_RUNNING,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription:
      'GitHub reconciliation observed the pull request closed without merging while CI was running — irreconcilable divergence (docs/01 §5.7)',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-github:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  // round-8 HIGH-1: reconcile.ts's `irreconcilablyClosed` check fires for *every* non-terminal
  // feature-execution state (MERGED/HUMAN_REQUIRED/BLOCKED/FAILED are the only states it treats as
  // terminal), not just pr_opened/ci_running — a maintainer can close a PR without merging while a
  // feature run is anywhere mid-flight (e.g. a fix-cycle re-push has it back at code_pushed, or a
  // reviewer's findings have it at changes_requested/fixing while GitHub closes the PR out from
  // under it). Before this round, EscalateToHumanHandler's unconditional
  // `validator.assertValid(fromState, HUMAN_REQUIRED)` threw TransitionError for all 8 of these
  // states, so the escalation reconcile.ts intends to make would crash instead. The 8 entries below
  // cover every non-terminal state that lacked one, so the matrix's coverage now matches
  // reconcile.ts's actual guard rather than narrowing the guard to fit an incomplete matrix.
  {
    fromState: FeatureExecutionState.APPROVED_PENDING_EXECUTION,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription:
      "GitHub reconciliation observed the pull request closed without merging while the feature run was in state 'approved_pending_execution' — irreconcilable divergence (docs/01 §5.7)",
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-github:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  {
    fromState: FeatureExecutionState.SELECTED,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription:
      "GitHub reconciliation observed the pull request closed without merging while the feature run was in state 'selected' — irreconcilable divergence (docs/01 §5.7)",
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-github:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  {
    fromState: FeatureExecutionState.CODING,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription:
      "GitHub reconciliation observed the pull request closed without merging while the feature run was in state 'coding' — irreconcilable divergence (docs/01 §5.7)",
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-github:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  {
    fromState: FeatureExecutionState.CODE_PUSHED,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription:
      "GitHub reconciliation observed the pull request closed without merging while the feature run was in state 'code_pushed' — irreconcilable divergence (docs/01 §5.7)",
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-github:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  {
    fromState: FeatureExecutionState.CHANGES_REQUESTED,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription:
      "GitHub reconciliation observed the pull request closed without merging while the feature run was in state 'changes_requested' — irreconcilable divergence (docs/01 §5.7)",
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-github:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  {
    fromState: FeatureExecutionState.FIXING,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription:
      "GitHub reconciliation observed the pull request closed without merging while the feature run was in state 'fixing' — irreconcilable divergence (docs/01 §5.7)",
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-github:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  {
    fromState: FeatureExecutionState.APPROVED_BY_POLICY,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription:
      "GitHub reconciliation observed the pull request closed without merging while the feature run was in state 'approved_by_policy' — irreconcilable divergence (docs/01 §5.7)",
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-github:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  {
    fromState: FeatureExecutionState.MERGE_READY,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription:
      "GitHub reconciliation observed the pull request closed without merging while the feature run was in state 'merge_ready' — irreconcilable divergence (docs/01 §5.7)",
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-github:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  // ── CI outcomes ───────────────────────────────────────────────────────────
  {
    fromState: FeatureExecutionState.CI_RUNNING,
    toState: FeatureExecutionState.UNDER_REVIEW,
    triggeringCommand: 'RecordCiPassedCommand',
    actor: 'system',
    guardDescription: 'CI check run concluded with success status',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.ci_passed'],
    idempotencyKeyTemplate: 'record-ci-passed:{featureRunId}:{checkRunId}',
    recoveryPath: 'Idempotent: same checkRunId returns cached result',
  },
  {
    fromState: FeatureExecutionState.CI_RUNNING,
    toState: FeatureExecutionState.CI_FAILED,
    triggeringCommand: 'RecordCiFailedCommand',
    actor: 'system',
    guardDescription: 'CI check run concluded with failure status',
    sideEffects: ['record_blocking_finding', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.ci_failed'],
    idempotencyKeyTemplate: 'record-ci-failed:{featureRunId}:{checkRunId}',
    recoveryPath: 'Idempotent: same checkRunId returns cached result',
  },
  {
    fromState: FeatureExecutionState.CI_FAILED,
    toState: FeatureExecutionState.CHANGES_REQUESTED,
    triggeringCommand: 'RequestChangesAfterCiFailCommand',
    actor: 'system',
    guardDescription: 'fix-attempt count < per-feature threshold',
    sideEffects: ['increment_fix_attempt_count', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.changes_requested'],
    // Phase 10 code-review fix: this edge can recur across multiple CI-failure cycles for the
    // same feature run (ci_running -> ci_failed -> changes_requested -> fixing -> ... -> ci_failed
    // again), so a key scoped to {featureRunId} alone would replay the first cycle's cached
    // result for every later one within the idempotency TTL — the same class of bug already fixed
    // for start-fixing/budget-control keys elsewhere in this matrix (see CLAUDE.md).
    idempotencyKeyTemplate: 'changes-requested-after-ci:{featureRunId}:{expectedVersion}',
    recoveryPath: 'Idempotent per occurrence: retrying the same cycle returns cached result',
  },
  {
    fromState: FeatureExecutionState.CI_FAILED,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription: 'fix-attempt count >= per-feature threshold (review-cycle limit exceeded)',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-ci-limit:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  // ── Review loop ───────────────────────────────────────────────────────────
  {
    fromState: FeatureExecutionState.UNDER_REVIEW,
    toState: FeatureExecutionState.CHANGES_REQUESTED,
    triggeringCommand: 'RecordChangesRequestedCommand',
    actor: 'system',
    guardDescription: 'reviewer produced blocking findings; fix-attempt count < threshold',
    sideEffects: ['increment_fix_attempt_count', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.changes_requested'],
    idempotencyKeyTemplate: 'changes-requested:{featureRunId}:{reviewId}',
    recoveryPath: 'Idempotent: same reviewId returns cached result',
  },
  {
    fromState: FeatureExecutionState.UNDER_REVIEW,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription: 'requires_human_decision finding present, or fix-attempt limit exceeded',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-review:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  {
    fromState: FeatureExecutionState.UNDER_REVIEW,
    toState: FeatureExecutionState.APPROVED_BY_POLICY,
    triggeringCommand: 'RecordApprovedByPolicyCommand',
    actor: 'system',
    guardDescription: 'merge gate passes: no blocking findings, CI green, required approvals met',
    sideEffects: ['write_merge_gate_evaluation', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.approved_by_policy'],
    idempotencyKeyTemplate: 'approved-by-policy:{featureRunId}',
    recoveryPath: 'Idempotent: returns cached result if already approved',
  },
  {
    fromState: FeatureExecutionState.CHANGES_REQUESTED,
    toState: FeatureExecutionState.FIXING,
    triggeringCommand: 'StartFixingCommand',
    actor: 'system',
    guardDescription: 'workflow lock held with valid fence; automation running',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.fixing_started'],
    // {expectedVersion} discriminates repeated fix cycles for the same feature run over its
    // lifetime (changes_requested -> fixing can recur across review rounds) — a key scoped to
    // {featureRunId} alone would replay the first cycle's cached result for every later one
    // within the idempotency TTL (MEDIUM-1 in the Phase 8 code review).
    idempotencyKeyTemplate: 'start-fixing:{featureRunId}:{expectedVersion}',
    recoveryPath:
      'Idempotent per fix-cycle occurrence: retrying the same cycle returns cached result',
  },
  {
    fromState: FeatureExecutionState.FIXING,
    toState: FeatureExecutionState.CODE_PUSHED,
    triggeringCommand: 'RecordCodePushedCommand',
    actor: 'system',
    guardDescription: 'workflow lock held with valid fence; commit sha provided',
    sideEffects: ['record_commit_sha', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.code_pushed'],
    idempotencyKeyTemplate: 'record-code-pushed:{featureRunId}:{commitSha}',
    recoveryPath: 'Idempotent: same commitSha returns cached result',
  },
  // ── Merge path ────────────────────────────────────────────────────────────
  {
    fromState: FeatureExecutionState.APPROVED_BY_POLICY,
    toState: FeatureExecutionState.MERGE_READY,
    triggeringCommand: 'MergeIfReadyCommand',
    actor: UserRole.APPROVER,
    guardDescription: 'merge gate re-evaluated immediately; all conditions still met',
    sideEffects: ['write_merge_gate_evaluation', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.merge_ready'],
    idempotencyKeyTemplate: 'merge-ready:{featureRunId}',
    recoveryPath: 'Idempotent: returns cached result if already merge_ready',
  },
  {
    fromState: FeatureExecutionState.MERGE_READY,
    toState: FeatureExecutionState.MERGED,
    triggeringCommand: 'RecordMergedCommand',
    actor: 'system',
    guardDescription: 'GitHub merge confirmed; merge commit sha provided',
    sideEffects: [
      'clear_active_feature_run',
      'record_merge_sha',
      'write_workflow_event',
      'write_outbox_event',
    ],
    emittedEvents: ['feature.merged'],
    idempotencyKeyTemplate: 'record-merged:{featureRunId}:{mergeSha}',
    recoveryPath: 'Idempotent: same mergeSha returns cached result',
  },
  {
    fromState: FeatureExecutionState.MERGE_READY,
    toState: FeatureExecutionState.MERGE_FAILED,
    triggeringCommand: 'RecordMergeFailedCommand',
    actor: 'system',
    guardDescription: 'GitHub merge attempt rejected after merge_ready',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.merge_failed'],
    // Phase 12 fix (matches the {expectedVersion}-discriminator rule already applied to
    // start-fixing/budget-control keys): merge_ready -> merge_failed can recur across more than
    // one merge attempt for the same feature run (merge_failed auto-clears back to under_review,
    // which can reach merge_ready again) — a key scoped to {featureRunId} alone would replay the
    // first failure's cached result for every later attempt within the idempotency TTL.
    idempotencyKeyTemplate: 'record-merge-failed:{featureRunId}:{expectedVersion}',
    recoveryPath: 'Reconciliation re-checks; routes to under_review or human_required',
  },
  {
    fromState: FeatureExecutionState.MERGE_FAILED,
    toState: FeatureExecutionState.UNDER_REVIEW,
    triggeringCommand: 'ReconcileMergeFailedCommand',
    actor: 'system',
    guardDescription: 'merge failure is auto-clearable (e.g. stale SHA; re-push resolves it)',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.returned_to_review'],
    // Phase 12 fix: same {expectedVersion}-discriminator rationale as record-merge-failed above —
    // a feature run can cycle through merge_failed more than once over its lifetime.
    idempotencyKeyTemplate: 'reconcile-merge-failed:{featureRunId}:{expectedVersion}',
    recoveryPath: 'Idempotent: returns cached result',
  },
  {
    fromState: FeatureExecutionState.MERGE_FAILED,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription: 'merge failure cannot be auto-cleared (branch protection, conflict)',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-merge-failed:{featureRunId}',
    recoveryPath: 'Human resolves via human_required disposition',
  },
  // ── Failure / escalation states ───────────────────────────────────────────
  {
    fromState: FeatureExecutionState.FAILED,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription: 'operation exhausted retries; requires human disposition',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-failed:{featureRunId}',
    recoveryPath: 'Human dispositions: retry, skip, or block',
  },
  {
    fromState: FeatureExecutionState.SYSTEM_FAILED,
    toState: FeatureExecutionState.HUMAN_REQUIRED,
    triggeringCommand: 'EscalateToHumanCommand',
    actor: 'system',
    guardDescription:
      'infrastructure/sandbox/timeout failure beyond retry thresholds; locks already released',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.human_required'],
    idempotencyKeyTemplate: 'escalate-human-system-failed:{featureRunId}',
    recoveryPath: 'Human reviews system diagnostics and retries or skips',
  },
  {
    fromState: FeatureExecutionState.BLOCKED,
    toState: FeatureExecutionState.APPROVED_PENDING_EXECUTION,
    triggeringCommand: 'UnblockFeatureCommand',
    actor: 'system',
    guardDescription: 'all blocking dependencies now merged; precondition satisfied',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.unblocked'],
    idempotencyKeyTemplate: 'unblock-feature:{featureRunId}',
    recoveryPath: 'Idempotent: returns cached result',
  },
  // ── Phase 11: human_required dispositions ────────────────────────────────
  // docs/00 §3.3: "human_required ... resolve, retry, skip, block, or resume". Five distinct
  // exit commands, one per disposition, all actor=approver (CLAUDE.md: "approver/admin required
  // for ... disagreement resolution ... and guarded/destructive lifecycle actions"). Before this
  // phase, human_required had no outgoing transitions at all.
  {
    fromState: FeatureExecutionState.HUMAN_REQUIRED,
    toState: FeatureExecutionState.CHANGES_REQUESTED,
    triggeringCommand: 'ResolveDisagreementCommand',
    actor: UserRole.APPROVER,
    guardDescription:
      'an open disagreement_records row exists for this feature run and is dispositioned "fix required" (reviewer_correct/compromise)',
    sideEffects: [
      'resolve_disagreement_record',
      'write_human_approval',
      'write_workflow_event',
      'write_outbox_event',
    ],
    emittedEvents: ['feature.disagreement_resolved'],
    idempotencyKeyTemplate: 'resolve-disagreement:{featureRunId}:{expectedVersion}',
    recoveryPath: 'Idempotent per occurrence: retrying the same escalation returns cached result',
  },
  {
    fromState: FeatureExecutionState.HUMAN_REQUIRED,
    toState: FeatureExecutionState.UNDER_REVIEW,
    triggeringCommand: 'ResumeFeatureExecutionCommand',
    actor: UserRole.APPROVER,
    guardDescription:
      'human (optionally via a resolved disagreement) determines no further code change is needed; resumes the review/merge flow directly',
    sideEffects: ['write_human_approval', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.resumed_from_human_required'],
    idempotencyKeyTemplate: 'resume-feature-execution:{featureRunId}:{expectedVersion}',
    recoveryPath: 'Idempotent per occurrence: retrying the same escalation returns cached result',
  },
  {
    fromState: FeatureExecutionState.HUMAN_REQUIRED,
    toState: FeatureExecutionState.SELECTED,
    triggeringCommand: 'RetryFeatureCommand',
    actor: UserRole.APPROVER,
    guardDescription:
      'human decides to retry automation from the top (e.g. a transient system_failed/failed condition); automation=running',
    sideEffects: ['write_human_approval', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.retried'],
    idempotencyKeyTemplate: 'retry-feature:{featureRunId}:{expectedVersion}',
    recoveryPath: 'Idempotent per occurrence: retrying the same escalation returns cached result',
  },
  {
    fromState: FeatureExecutionState.HUMAN_REQUIRED,
    toState: FeatureExecutionState.SKIPPED,
    triggeringCommand: 'SkipFeatureCommand',
    actor: UserRole.APPROVER,
    guardDescription: 'human explicitly abandons automation for this feature; terminal',
    sideEffects: ['write_human_approval', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.skipped'],
    idempotencyKeyTemplate: 'skip-feature:{featureRunId}:{expectedVersion}',
    recoveryPath: 'Idempotent per occurrence: retrying the same escalation returns cached result',
  },
  {
    fromState: FeatureExecutionState.HUMAN_REQUIRED,
    toState: FeatureExecutionState.BLOCKED,
    triggeringCommand: 'BlockFeatureCommand',
    actor: UserRole.APPROVER,
    guardDescription:
      'human identifies an external precondition that must be satisfied before automation resumes',
    sideEffects: ['write_human_approval', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['feature.blocked_by_human'],
    idempotencyKeyTemplate: 'block-feature:{featureRunId}:{expectedVersion}',
    recoveryPath:
      'Human-initiated block; UnblockFeatureCommand only clears once dependencies are merged — a human-blocked feature with no unmet dependency requires RetryFeatureCommand instead (known limitation, see docs/06 Phase 11)',
  },
] as const;
