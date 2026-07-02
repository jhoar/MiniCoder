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

export const ApproveBudgetOverridePayloadSchema = z.object({
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  overrideReason: z.string().min(1),
  approvedBudgetPolicyId: z.string(),
});
export type ApproveBudgetOverridePayload = z.infer<typeof ApproveBudgetOverridePayloadSchema>;

const validator = new StateTransitionValidator(AUTOMATION_CONTROL_MATRIX, 'automation-control');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface WorkflowStateRow {
  id: string;
  automation_state: string;
  version: number;
}

/**
 * Serves both matrix edges that land on ApproveBudgetOverrideCommand
 * (paused_budget_exceeded -> running and waiting_for_budget_approval -> running) — the
 * validator resolves the correct matrix row from (fromState, commandName), so a single
 * handler implementation is correct for both origin states.
 *
 * Callers must pick the idempotency key template matching the origin state they observed
 * ('budget-override:{projectId}' for a hard-limit override, 'budget-override-waiting:{projectId}'
 * for a soft-limit override) — unlike every other handler in this codebase, this command does
 * not have one fixed idempotency-key template, because it serves two distinct matrix edges.
 */
export class ApproveBudgetOverrideHandler implements CommandHandler<
  ApproveBudgetOverridePayload,
  AutomationState
> {
  readonly commandName = 'ApproveBudgetOverrideCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'approve-budget-override';

  async execute(
    envelope: CommandEnvelope<ApproveBudgetOverridePayload>,
    db: DbClient,
  ): Promise<CommandResult<AutomationState>> {
    const { projectId, expectedVersion, overrideReason, approvedBudgetPolicyId } =
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
        policyType: 'budget_override',
        decision: 'approved',
        context: { overrideReason, approvedBudgetPolicyId, fromState },
        actor: envelope.actor.id,
      });

      // Matrix declares two emittedEvents for this edge: the override decision itself, and the
      // automation resuming as a consequence of it. Both are recorded as distinct workflow events.
      const overrideEventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'automation.budget_override_approved',
        fromState,
        toState: AutomationState.RUNNING,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      const resumedEventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'automation.resumed',
        fromState,
        toState: AutomationState.RUNNING,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'automation.budget_override_approved',
        payload: { projectId, overrideReason, approvedBudgetPolicyId, fromState },
      });
      await writeOutboxEvent(tx, {
        eventType: 'automation.resumed',
        payload: { projectId, reason: 'budget_override' },
      });
      const result: CommandResult<AutomationState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: AutomationState.RUNNING,
        emittedEventIds: [overrideEventId, resumedEventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
