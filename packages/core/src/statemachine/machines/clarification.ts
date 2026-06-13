import { UserRole } from '../../domain/states.js';
import type { StateMatrix } from '../types.js';

// Clarification uses status strings (not a separate enum in states.ts)
export type ClarificationStatus =
  | 'clarification_not_required'
  | 'clarification_required'
  | 'clarification_in_progress'
  | 'clarification_complete'
  | 'clarification_blocked';

export const CLARIFICATION_MATRIX: StateMatrix<ClarificationStatus> = [
  {
    fromState: 'clarification_not_required',
    toState: 'clarification_complete',
    triggeringCommand: 'MarkClarificationNotRequiredCommand',
    actor: 'system',
    guardDescription: 'PlannerAgentAdapter assessed spec as sufficient; no questions needed',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['clarification.not_required'],
    idempotencyKeyTemplate: 'clarification-not-required:{projectId}',
    recoveryPath: 'Idempotent: returns cached result',
  },
  {
    fromState: 'clarification_required',
    toState: 'clarification_in_progress',
    triggeringCommand: 'StartClarificationCommand',
    actor: UserRole.OPERATOR,
    guardDescription: 'clarification session not yet started; round count < 3',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['clarification.started'],
    idempotencyKeyTemplate: 'start-clarification:{projectId}:{round}',
    recoveryPath: 'Idempotent: returns cached result',
  },
  {
    fromState: 'clarification_in_progress',
    toState: 'clarification_complete',
    triggeringCommand: 'CompleteClarificationCommand',
    actor: UserRole.OPERATOR,
    guardDescription: 'all clarification questions answered; spec now sufficient',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['clarification.complete'],
    idempotencyKeyTemplate: 'complete-clarification:{projectId}',
    recoveryPath: 'Idempotent: returns cached result',
  },
  {
    fromState: 'clarification_in_progress',
    toState: 'clarification_required',
    triggeringCommand: 'RequestAnotherClarificationRoundCommand',
    actor: 'system',
    guardDescription: 'round timeout or additional questions needed; round count < 3',
    sideEffects: ['increment_round_count', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['clarification.round_completed'],
    idempotencyKeyTemplate: 'clarification-next-round:{projectId}:{round}',
    recoveryPath: 'Idempotent: returns cached result',
  },
  {
    fromState: 'clarification_in_progress',
    toState: 'clarification_blocked',
    triggeringCommand: 'BlockClarificationCommand',
    actor: 'system',
    guardDescription: 'round count >= 3 or per-round timeout exceeded',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['clarification.blocked'],
    idempotencyKeyTemplate: 'clarification-blocked:{projectId}',
    recoveryPath: 'Escalates to human_required on the feature/project level',
  },
  {
    fromState: 'clarification_required',
    toState: 'clarification_blocked',
    triggeringCommand: 'BlockClarificationCommand',
    actor: 'system',
    guardDescription: 'round count >= 3 (circuit breaker)',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['clarification.blocked'],
    idempotencyKeyTemplate: 'clarification-blocked-from-required:{projectId}',
    recoveryPath: 'Escalates to human_required',
  },
] as const;
