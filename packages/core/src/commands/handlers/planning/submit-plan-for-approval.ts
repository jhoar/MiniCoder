import { z } from 'zod';
import { GapSeverity, PlanState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { PLAN_LIFECYCLE_MATRIX } from '../../../statemachine/machines/plan-lifecycle.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import { OptimisticLockError } from '../../../persistence/types.js';
import { CommandError } from '../../types.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import {
  isoNow,
  writeWorkflowEvent,
  writeOutboxEvent,
  claimIdempotencyKey,
  fulfillIdempotencyKey,
} from '../../helpers.js';

export const SubmitPlanForApprovalPayloadSchema = z.object({
  planId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type SubmitPlanForApprovalPayload = z.infer<typeof SubmitPlanForApprovalPayloadSchema>;

const validator = new StateTransitionValidator(PLAN_LIFECYCLE_MATRIX, 'plan-lifecycle');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PlanRow {
  id: string;
  state: string;
  version: number;
  assessment_id: string | null;
  backlog_version: number;
  backlog_validated_state: string | null;
  backlog_validated_version: number | null;
}

/**
 * plan-lifecycle draft -> pending_approval, gated on ValidateBacklogCommand having passed for the
 * plan's *current* backlog (backlog_validated_state = 'valid' AND backlog_validated_version =
 * backlog_version — a backlog regeneration resets those columns to NULL, so a stale validation
 * from before the latest GenerateFeatureBacklogCommand/ImportBacklogCommand call does not count)
 * and no unresolved blocking planning_gaps.
 */
export class SubmitPlanForApprovalHandler implements CommandHandler<
  SubmitPlanForApprovalPayload,
  PlanState
> {
  readonly commandName = 'SubmitPlanForApprovalCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'submit-plan-for-approval';

  async execute(
    envelope: CommandEnvelope<SubmitPlanForApprovalPayload>,
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
        `SELECT id, state, version, assessment_id, backlog_version, backlog_validated_state, backlog_validated_version
         FROM implementation_plans WHERE id = ? AND project_id = ?`,
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
      validator.assertValid(plan.state as PlanState, PlanState.PENDING_APPROVAL);

      if (
        plan.backlog_validated_state !== 'valid' ||
        plan.backlog_validated_version !== plan.backlog_version
      ) {
        throw new CommandError({
          type: 'backlog-not-validated',
          title: 'Backlog has not passed validation',
          status: 409,
          detail: `Plan ${planId} requires a passing ValidateBacklogCommand run against its current backlog (backlog_version=${plan.backlog_version}) before it can be submitted for approval`,
          instance: envelope.correlationId,
        });
      }

      // Scoped to the plan's own assessment_id, not the whole project — a project can have
      // multiple readiness assessments (e.g. a superseded or re-run one), and an unresolved
      // blocking gap tied to an assessment this plan wasn't generated from has nothing to do with
      // the plan being submitted (see issue #31; same class of bug already fixed for
      // GenerateImplementationPlanHandler's clarification guard). A plan with no assessment_id
      // (e.g. an imported plan/backlog) has no assessment-scoped gaps to block on.
      const unresolvedBlockingGaps = plan.assessment_id
        ? await tx.query<{ id: string }>(
            `SELECT id FROM planning_gaps WHERE assessment_id = ? AND severity = ? AND resolved_at IS NULL`,
            [plan.assessment_id, GapSeverity.BLOCKING],
          )
        : [];
      if (unresolvedBlockingGaps.length > 0) {
        throw new CommandError({
          type: 'unresolved-blocking-gaps',
          title: 'Unresolved blocking gaps',
          status: 409,
          detail: `${unresolvedBlockingGaps.length} unresolved blocking gap(s) for assessment ${plan.assessment_id}`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE implementation_plans SET state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [PlanState.PENDING_APPROVAL, nextVersion(plan.version), now, planId, expectedVersion],
      );
      if (affected === 0) {
        throw new OptimisticLockError('implementation_plans', planId, expectedVersion, -1);
      }

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'plan.submitted_for_approval',
        fromState: PlanState.DRAFT,
        toState: PlanState.PENDING_APPROVAL,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'plan.submitted_for_approval',
        payload: { planId, projectId },
      });

      const result: CommandResult<PlanState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: PlanState.PENDING_APPROVAL,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
