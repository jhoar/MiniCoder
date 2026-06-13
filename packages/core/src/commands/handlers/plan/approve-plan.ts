import { z } from 'zod';
import { PlanState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { PLAN_LIFECYCLE_MATRIX } from '../../../statemachine/machines/plan-lifecycle.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import { isoNow, generateId, writeWorkflowEvent, writeOutboxEvent, writeIdempotencyKey } from '../../helpers.js';

export const ApprovePlanPayloadSchema = z.object({
  planId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  notes: z.string().optional(),
});
export type ApprovePlanPayload = z.infer<typeof ApprovePlanPayloadSchema>;

const validator = new StateTransitionValidator(PLAN_LIFECYCLE_MATRIX, 'plan-lifecycle');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PlanRow { id: string; state: string; version: number; }

export class ApprovePlanHandler implements CommandHandler<ApprovePlanPayload, PlanState> {
  readonly commandName = 'ApprovePlanCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly idempotencyScope = 'approve-plan';

  async execute(envelope: CommandEnvelope<ApprovePlanPayload>, db: DbClient): Promise<CommandResult<PlanState>> {
    const { planId, projectId, expectedVersion } = envelope.payload;
    return db.transaction(async (tx) => {
      const rows = await tx.query<PlanRow>(`SELECT id, state, version FROM implementation_plans WHERE id = ?`, [planId]);
      const plan = rows[0];
      assertVersion('implementation_plans', planId, plan, expectedVersion);
      validator.assertValid(plan.state as PlanState, PlanState.APPROVED);
      const now = isoNow();
      await tx.execute(`UPDATE implementation_plans SET state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`, [PlanState.APPROVED, nextVersion(plan.version), now, planId, expectedVersion]);
      // human_approvals columns: context_type (not approval_type), actor + actor_role (not actor_id)
      await tx.execute(
        `INSERT INTO human_approvals (id, project_id, context_type, context_id, actor, actor_role, version, created_at, updated_at) VALUES (?, ?, 'plan_approval', ?, ?, ?, 1, ?, ?)`,
        [generateId(), projectId, planId, envelope.actor.id, envelope.actor.role, now, now],
      );
      const eventId = await writeWorkflowEvent(tx, { projectId, eventType: 'plan.approved', fromState: PlanState.PENDING_APPROVAL, toState: PlanState.APPROVED, actorId: envelope.actor.id, correlationId: envelope.correlationId });
      await writeOutboxEvent(tx, { eventType: 'plan.approved', payload: { planId, projectId } });
      const result: CommandResult<PlanState> = { commandId: envelope.commandId, accepted: true, resultingState: PlanState.APPROVED, emittedEventIds: [eventId] };
      await writeIdempotencyKey(tx, { key: envelope.idempotencyKey, scope: this.idempotencyScope, result, ttlMs: IDEMPOTENCY_TTL_MS });
      return result;
    });
  }
}
