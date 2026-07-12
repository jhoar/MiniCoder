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

export const RecordBudgetExceededPayloadSchema = z.object({
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  breachedPolicyId: z.string(),
  currentSpend: z.number(),
  hardLimit: z.number(),
  // Phase 16 (post-merge PR review fix, MEDIUM-2): optional — the automatic breach this handler
  // records is project-scoped (workflow_states has no feature_run_id), but a caller that already
  // knows which feature run's pre-flight forecast triggered the breach (budget-preflight.ts) can
  // attribute the resulting workflow_events row to that feature run, so
  // `GET /feature-runs/:id/timeline` can explain why that feature run's adapter call never
  // happened. Omitted by every other caller (the Phase 8 retrospective post-hoc path has no
  // single feature run to attribute a project-wide breach to).
  featureRunId: z.string().min(1).optional(),
});
export type RecordBudgetExceededPayload = z.infer<typeof RecordBudgetExceededPayloadSchema>;

const validator = new StateTransitionValidator(AUTOMATION_CONTROL_MATRIX, 'automation-control');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface WorkflowStateRow {
  id: string;
  automation_state: string;
  version: number;
}

/**
 * Matrix side effects for this edge are write_workflow_event/write_outbox_event only
 * (no record_policy_decision) — the decision record belongs to the human override that
 * eventually clears this state (ApproveBudgetOverrideHandler), not to the system-triggered
 * breach itself.
 */
export class RecordBudgetExceededHandler implements CommandHandler<
  RecordBudgetExceededPayload,
  AutomationState
> {
  readonly commandName = 'RecordBudgetExceededCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'record-budget-exceeded';

  async execute(
    envelope: CommandEnvelope<RecordBudgetExceededPayload>,
    db: DbClient,
  ): Promise<CommandResult<AutomationState>> {
    const { projectId, expectedVersion, breachedPolicyId, currentSpend, hardLimit, featureRunId } =
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
        AutomationState.PAUSED_BUDGET_EXCEEDED,
      );
      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE workflow_states SET automation_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          AutomationState.PAUSED_BUDGET_EXCEEDED,
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
        featureRunId,
        eventType: 'automation.budget_exceeded',
        fromState: AutomationState.RUNNING,
        toState: AutomationState.PAUSED_BUDGET_EXCEEDED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'automation.budget_exceeded',
        payload: { projectId, breachedPolicyId, currentSpend, hardLimit },
      });
      const result: CommandResult<AutomationState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: AutomationState.PAUSED_BUDGET_EXCEEDED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
