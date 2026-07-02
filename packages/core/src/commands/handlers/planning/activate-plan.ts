import { z } from 'zod';
import { FeatureExecutionState, FeatureKind, PlanState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { PLAN_LIFECYCLE_MATRIX } from '../../../statemachine/machines/plan-lifecycle.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import { OptimisticLockError } from '../../../persistence/types.js';
import { CommandError } from '../../types.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import {
  isoNow,
  generateId,
  writeWorkflowEvent,
  writeOutboxEvent,
  claimIdempotencyKey,
  fulfillIdempotencyKey,
} from '../../helpers.js';

export const ActivatePlanPayloadSchema = z.object({
  planId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type ActivatePlanPayload = z.infer<typeof ActivatePlanPayloadSchema>;

const validator = new StateTransitionValidator(PLAN_LIFECYCLE_MATRIX, 'plan-lifecycle');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PlanRow {
  id: string;
  state: string;
  version: number;
}

/**
 * plan-lifecycle approved -> activated_for_execution. `feature_requests.state` is a static label
 * set once at generation time (see select-feature.ts: "feature_requests.state is never updated by
 * transitions — only feature_runs.current_execution_state is"), so the real
 * "set_feature_requests_to_approved_pending_execution" side effect from the matrix is: insert one
 * feature_runs row (attempt_no=1, current_execution_state=approved_pending_execution) per
 * kind='feature' feature_request under this plan. kind='discovery' rows are skipped — a discovery
 * backlog is never executable (docs/02 §5).
 */
export class ActivatePlanHandler implements CommandHandler<ActivatePlanPayload, PlanState> {
  readonly commandName = 'ActivatePlanCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'activate-plan';

  async execute(
    envelope: CommandEnvelope<ActivatePlanPayload>,
    db: DbClient,
  ): Promise<CommandResult<PlanState>> {
    const { planId, projectId, expectedVersion } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<PlanState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const rows = await tx.query<PlanRow>(
        `SELECT id, state, version FROM implementation_plans WHERE id = ? AND project_id = ?`,
        [planId, projectId],
      );
      const plan = rows[0];
      if (!plan) {
        throw new CommandError({
          type: 'not-found',
          title: 'Plan not found',
          status: 404,
          detail: `Plan ${planId} not found in project ${projectId}`,
          instance: envelope.correlationId,
        });
      }
      assertVersion('implementation_plans', planId, plan, expectedVersion);
      validator.assertValid(plan.state as PlanState, PlanState.ACTIVATED_FOR_EXECUTION);

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE implementation_plans SET state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          PlanState.ACTIVATED_FOR_EXECUTION,
          nextVersion(plan.version),
          now,
          planId,
          expectedVersion,
        ],
      );
      if (affected === 0) {
        throw new OptimisticLockError('implementation_plans', planId, expectedVersion, -1);
      }

      const executableFeatures = await tx.query<{ id: string }>(
        `SELECT id FROM feature_requests WHERE plan_id = ? AND kind = ?`,
        [planId, FeatureKind.FEATURE],
      );

      let activatedFeatureCount = 0;
      for (const feature of executableFeatures) {
        const existing = await tx.query<{ id: string }>(
          `SELECT id FROM feature_runs WHERE feature_request_id = ? AND attempt_no = 1`,
          [feature.id],
        );
        if (existing.length > 0) continue;
        await tx.execute(
          `INSERT INTO feature_runs
             (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
           VALUES (?, ?, 1, ?, 1, ?, ?)`,
          [generateId(), feature.id, FeatureExecutionState.APPROVED_PENDING_EXECUTION, now, now],
        );
        activatedFeatureCount++;
      }

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'plan.activated',
        fromState: PlanState.APPROVED,
        toState: PlanState.ACTIVATED_FOR_EXECUTION,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'plan.activated',
        payload: { planId, projectId, activatedFeatureCount },
      });

      const result: CommandResult<PlanState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: PlanState.ACTIVATED_FOR_EXECUTION,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
