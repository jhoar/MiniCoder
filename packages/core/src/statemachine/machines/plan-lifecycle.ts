import { PlanState, UserRole } from '../../domain/states.js';
import type { StateMatrix } from '../types.js';

export const PLAN_LIFECYCLE_MATRIX: StateMatrix<PlanState> = [
  {
    fromState: PlanState.DRAFT,
    toState: PlanState.PENDING_APPROVAL,
    triggeringCommand: 'SubmitPlanForApprovalCommand',
    actor: UserRole.OPERATOR,
    guardDescription: 'implementation plan generated; all planning gaps resolved or accepted',
    sideEffects: ['write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['plan.submitted_for_approval'],
    idempotencyKeyTemplate: 'submit-plan:{planId}',
    recoveryPath: 'Idempotent: returns cached result if already pending_approval',
  },
  {
    fromState: PlanState.PENDING_APPROVAL,
    toState: PlanState.APPROVED,
    triggeringCommand: 'ApprovePlanCommand',
    actor: UserRole.APPROVER,
    guardDescription: 'no blocking planning gaps unless explicitly accepted by approver',
    sideEffects: ['record_human_approval', 'write_workflow_event', 'write_outbox_event'],
    emittedEvents: ['plan.approved'],
    idempotencyKeyTemplate: 'approve-plan:{planId}',
    recoveryPath: 'Idempotent: returns cached result if already approved',
  },
  {
    fromState: PlanState.APPROVED,
    toState: PlanState.ACTIVATED_FOR_EXECUTION,
    triggeringCommand: 'ActivatePlanCommand',
    actor: UserRole.APPROVER,
    guardDescription:
      'all feature requests are executable (kind!=discovery); no unresolved blocking gaps',
    sideEffects: [
      'set_feature_requests_to_approved_pending_execution',
      'write_workflow_event',
      'write_outbox_event',
    ],
    emittedEvents: ['plan.activated'],
    idempotencyKeyTemplate: 'activate-plan:{planId}',
    recoveryPath:
      'Idempotent: returns cached result if already activated; feature requests are idempotently set',
  },
] as const;
