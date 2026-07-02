import { z } from 'zod';
import { AutomationState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { AUTOMATION_CONTROL_MATRIX } from '../../../statemachine/machines/automation-control.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import { OptimisticLockError } from '../../../persistence/types.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import {
  isoNow,
  writeWorkflowEvent,
  writeOutboxEvent,
  claimIdempotencyKey,
  fulfillIdempotencyKey,
} from '../../helpers.js';

export const RecordBudgetApprovalWaitingPayloadSchema = z.object({
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  breachedPolicyId: z.string(),
  currentSpend: z.number(),
  softLimit: z.number(),
});
export type RecordBudgetApprovalWaitingPayload = z.infer<
  typeof RecordBudgetApprovalWaitingPayloadSchema
>;

const validator = new StateTransitionValidator(AUTOMATION_CONTROL_MATRIX, 'automation-control');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface WorkflowStateRow {
  id: string;
  automation_state: string;
  version: number;
}

/** No record_policy_decision side effect here either — see RecordBudgetExceededHandler. */
export class RecordBudgetApprovalWaitingHandler implements CommandHandler<
  RecordBudgetApprovalWaitingPayload,
  AutomationState
> {
  readonly commandName = 'RecordBudgetApprovalWaitingCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'record-budget-approval-waiting';

  async execute(
    envelope: CommandEnvelope<RecordBudgetApprovalWaitingPayload>,
    db: DbClient,
  ): Promise<CommandResult<AutomationState>> {
    const { projectId, expectedVersion, breachedPolicyId, currentSpend, softLimit } =
      envelope.payload;
    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<AutomationState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const rows = await tx.query<WorkflowStateRow>(
        `SELECT id, automation_state, version FROM workflow_states WHERE project_id = ?`,
        [projectId],
      );
      const ws = rows[0];
      assertVersion('workflow_states', projectId, ws, expectedVersion);
      validator.assertValid(
        ws.automation_state as AutomationState,
        AutomationState.WAITING_FOR_BUDGET_APPROVAL,
      );
      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE workflow_states SET automation_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          AutomationState.WAITING_FOR_BUDGET_APPROVAL,
          nextVersion(ws.version),
          now,
          ws.id,
          expectedVersion,
        ],
      );
      if (affected === 0) {
        throw new OptimisticLockError('workflow_states', projectId, expectedVersion, -1);
      }

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'automation.budget_approval_waiting',
        fromState: AutomationState.RUNNING,
        toState: AutomationState.WAITING_FOR_BUDGET_APPROVAL,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'automation.budget_approval_waiting',
        payload: { projectId, breachedPolicyId, currentSpend, softLimit },
      });
      const result: CommandResult<AutomationState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: AutomationState.WAITING_FOR_BUDGET_APPROVAL,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
