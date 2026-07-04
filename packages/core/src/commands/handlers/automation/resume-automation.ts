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
  insertPolicyDecision,
} from '../../helpers.js';

export const ResumeAutomationPayloadSchema = z.object({
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type ResumeAutomationPayload = z.infer<typeof ResumeAutomationPayloadSchema>;

const validator = new StateTransitionValidator(AUTOMATION_CONTROL_MATRIX, 'automation-control');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface WorkflowStateRow {
  id: string;
  automation_state: string;
  version: number;
}

/**
 * paused_by_operator -> running. See PauseAutomationHandler for why callers must include a
 * per-occurrence discriminator (e.g. {expectedVersion}) beyond {projectId} in the idempotency
 * key.
 */
export class ResumeAutomationHandler implements CommandHandler<
  ResumeAutomationPayload,
  AutomationState
> {
  readonly commandName = 'ResumeAutomationCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'resume-automation';

  async execute(
    envelope: CommandEnvelope<ResumeAutomationPayload>,
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
      const fromState = ws.automation_state as AutomationState;
      validator.assertValid(fromState, AutomationState.RUNNING);
      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE workflow_states SET automation_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [AutomationState.RUNNING, nextVersion(ws.version), now, ws.id, expectedVersion],
      );
      if (affected === 0) {
        throw new OptimisticLockError('workflow_states', projectId, expectedVersion, -1);
      }

      await insertPolicyDecision(tx, {
        projectId,
        policyType: 'automation_resume',
        decision: 'resumed',
        context: { fromState },
        actor: envelope.actor.id,
      });

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'automation.resumed',
        fromState,
        toState: AutomationState.RUNNING,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'automation.resumed',
        payload: { projectId, reason: 'operator' },
      });
      const result: CommandResult<AutomationState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: AutomationState.RUNNING,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
