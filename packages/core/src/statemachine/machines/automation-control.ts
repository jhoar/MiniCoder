import { AutomationState, UserRole } from '../../domain/states.js';
import type { StateMatrix } from '../types.js';

export const AUTOMATION_CONTROL_MATRIX: StateMatrix<AutomationState> = [
  {
    fromState: AutomationState.RUNNING,
    toState: AutomationState.PAUSED_BY_OPERATOR,
    triggeringCommand: 'PauseAutomationCommand',
    actor: UserRole.OPERATOR,
    guardDescription: 'operator-initiated pause',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['automation.paused_by_operator'],
    // {expectedVersion} discriminates repeated pauses of the same project over its lifetime
    // (pause -> resume -> pause again is a legitimate operator workflow) — a key scoped to
    // {projectId} alone would replay the first pause's cached result for every later one within
    // the idempotency TTL, leaving automation running when a second pause should have applied
    // (MEDIUM-1 in the Phase 8 code review, same class of bug as HIGH-1's budget-breach keys).
    idempotencyKeyTemplate: 'pause-automation:{projectId}:{expectedVersion}',
    recoveryPath: 'Idempotent per pause occurrence: retrying the same pause returns cached result',
  },
  {
    fromState: AutomationState.PAUSED_BY_OPERATOR,
    toState: AutomationState.RUNNING,
    triggeringCommand: 'ResumeAutomationCommand',
    actor: UserRole.OPERATOR,
    guardDescription: 'operator resumes; records resumed event',
    sideEffects: ['record_policy_decision', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['automation.resumed'],
    // See PauseAutomationCommand above for why {expectedVersion} is required here too.
    idempotencyKeyTemplate: 'resume-automation:{projectId}:{expectedVersion}',
    recoveryPath:
      'Idempotent per resume occurrence: retrying the same resume returns cached result',
  },
  {
    fromState: AutomationState.RUNNING,
    toState: AutomationState.PAUSED_BUDGET_EXCEEDED,
    triggeringCommand: 'RecordBudgetExceededCommand',
    actor: 'system',
    guardDescription: 'hard budget limit breached',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['automation.budget_exceeded'],
    // {expectedVersion} is workflow_states' version at read time, not a caller-chosen value: it
    // discriminates repeated breaches of the same project over its lifetime (running is only
    // reached again after an override increments the version) while still deduplicating retries
    // of the *same* breach attempt, which observe the same version. A key scoped to {projectId}
    // alone would cache the first breach's result and silently no-op every later one within the
    // idempotency TTL — see HIGH-1 in the Phase 8 code review.
    idempotencyKeyTemplate: 'budget-exceeded:{projectId}:{policyId}:{expectedVersion}',
    recoveryPath:
      'Idempotent per breach occurrence: retrying the same breach returns cached result',
  },
  {
    fromState: AutomationState.PAUSED_BUDGET_EXCEEDED,
    toState: AutomationState.RUNNING,
    triggeringCommand: 'ApproveBudgetOverrideCommand',
    actor: UserRole.APPROVER,
    guardDescription: 'approver overrides budget and resumes',
    sideEffects: ['record_policy_decision', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['automation.budget_override_approved', 'automation.resumed'],
    // {expectedVersion} discriminates repeated overrides of the same project over its lifetime
    // (a project can breach, get overridden, and breach again) — same reasoning as
    // RecordBudgetExceededCommand above.
    idempotencyKeyTemplate: 'budget-override:{projectId}:{expectedVersion}',
    recoveryPath:
      'Idempotent per override occurrence: retrying the same override returns cached result',
  },
  {
    fromState: AutomationState.RUNNING,
    toState: AutomationState.WAITING_FOR_BUDGET_APPROVAL,
    triggeringCommand: 'RecordBudgetApprovalWaitingCommand',
    actor: 'system',
    guardDescription: 'soft budget limit breached; awaiting approver override',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['automation.budget_approval_waiting'],
    // See RecordBudgetExceededCommand above for why {expectedVersion} is required here too.
    idempotencyKeyTemplate: 'budget-approval-waiting:{projectId}:{policyId}:{expectedVersion}',
    recoveryPath:
      'Idempotent per breach occurrence: retrying the same breach returns cached result',
  },
  {
    fromState: AutomationState.WAITING_FOR_BUDGET_APPROVAL,
    toState: AutomationState.RUNNING,
    triggeringCommand: 'ApproveBudgetOverrideCommand',
    actor: UserRole.APPROVER,
    guardDescription: 'approver approves budget override',
    sideEffects: ['record_policy_decision', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['automation.budget_override_approved', 'automation.resumed'],
    // See the paused_budget_exceeded -> running edge above for why {expectedVersion} is required.
    idempotencyKeyTemplate: 'budget-override-waiting:{projectId}:{expectedVersion}',
    recoveryPath:
      'Idempotent per override occurrence: retrying the same override returns cached result',
  },
] as const;
