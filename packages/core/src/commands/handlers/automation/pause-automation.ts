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

export const PauseAutomationPayloadSchema = z.object({
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type PauseAutomationPayload = z.infer<typeof PauseAutomationPayloadSchema>;

const validator = new StateTransitionValidator(AUTOMATION_CONTROL_MATRIX, 'automation-control');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface WorkflowStateRow {
  id: string;
  automation_state: string;
  version: number;
}

export class PauseAutomationHandler implements CommandHandler<
  PauseAutomationPayload,
  AutomationState
> {
  readonly commandName = 'PauseAutomationCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'pause-automation';

  async execute(
    envelope: CommandEnvelope<PauseAutomationPayload>,
    db: DbClient,
  ): Promise<CommandResult<AutomationState>> {
    const { projectId, expectedVersion } = envelope.payload;
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
        AutomationState.PAUSED_BY_OPERATOR,
      );
      const now = isoNow();
      const pauseAffected = await tx.executeAffected(
        `UPDATE workflow_states SET automation_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [AutomationState.PAUSED_BY_OPERATOR, nextVersion(ws.version), now, ws.id, expectedVersion],
      );
      if (pauseAffected === 0) {
        throw new OptimisticLockError('workflow_states', projectId, expectedVersion, -1);
      }
      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'automation.paused_by_operator',
        fromState: AutomationState.RUNNING,
        toState: AutomationState.PAUSED_BY_OPERATOR,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'automation.paused_by_operator',
        payload: { projectId, reason: 'operator' },
      });
      const result: CommandResult<AutomationState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: AutomationState.PAUSED_BY_OPERATOR,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
