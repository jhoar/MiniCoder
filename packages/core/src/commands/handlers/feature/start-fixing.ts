import { z } from 'zod';
import { FeatureExecutionState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { FEATURE_EXECUTION_MATRIX } from '../../../statemachine/machines/feature-execution.js';
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
  assertLockFence,
} from '../../helpers.js';

export const StartFixingPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type StartFixingPayload = z.infer<typeof StartFixingPayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
}

/**
 * changes_requested -> fixing. Built in Phase 8 as a matrix-defined lock-gated transition
 * following StartCodingHandler's shape, but has no caller wired yet: the review/fix loop that
 * decides when a feature should re-enter fixing is Phase 10 scope.
 *
 * Like StartCodingHandler, this starts new automated work, so the same atomic
 * workflow_states.automation_state = 'running' re-check applies (HIGH-1 in the Phase 8 code
 * review): a pause/budget-pause that commits between an upstream caller's automation-state
 * pre-check and this command's dispatch must not let a fix cycle start anyway.
 *
 * Idempotency: the caller must include a per-occurrence discriminator (e.g.
 * {expectedVersion}) beyond {featureRunId} in the idempotency key — a feature run can cycle
 * through changes_requested -> fixing more than once over its lifetime (MEDIUM-1 in the Phase 8
 * code review), and a key scoped to featureRunId alone would replay the first cycle's cached
 * result for every later one within the idempotency TTL.
 */
export class StartFixingHandler implements CommandHandler<
  StartFixingPayload,
  FeatureExecutionState
> {
  readonly commandName = 'StartFixingCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'start-fixing';

  async execute(
    envelope: CommandEnvelope<StartFixingPayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion } = envelope.payload;
    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<FeatureExecutionState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      if (!envelope.lockContext) {
        throw new CommandError({
          type: 'missing-lock',
          title: 'Execution lock required',
          status: 400,
          detail: `${this.commandName} requires a workflow lock context`,
        });
      }
      await assertLockFence(tx, {
        ...envelope.lockContext,
        projectId,
        resourceKey: `execution-lane:${projectId}`,
      });

      const rows = await tx.query<FeatureRunRow>(
        `SELECT fr.id, fr.current_execution_state, fr.version
         FROM feature_runs fr
         JOIN feature_requests freq ON fr.feature_request_id = freq.id
         WHERE fr.id = ? AND freq.project_id = ?`,
        [featureRunId, projectId],
      );
      const run = rows[0];
      assertVersion('feature_runs', featureRunId, run, expectedVersion);
      validator.assertValid(
        run.current_execution_state as FeatureExecutionState,
        FeatureExecutionState.FIXING,
      );
      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?
           AND EXISTS (
             SELECT 1 FROM workflow_states
             WHERE project_id = ? AND automation_state = 'running'
           )`,
        [
          FeatureExecutionState.FIXING,
          nextVersion(run.version),
          now,
          featureRunId,
          expectedVersion,
          projectId,
        ],
      );
      if (affected === 0) {
        const wsRows = await tx.query<{ automation_state: string }>(
          `SELECT automation_state FROM workflow_states WHERE project_id = ?`,
          [projectId],
        );
        if (wsRows[0]?.automation_state !== 'running') {
          throw new CommandError({
            type: 'automation-paused',
            title: 'Automation is paused',
            status: 409,
            detail: `Cannot start fixing: automation is ${wsRows[0]?.automation_state ?? 'unknown'}`,
            instance: envelope.correlationId,
          });
        }
        throw new OptimisticLockError('feature_runs', featureRunId, expectedVersion, -1);
      }
      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'feature.fixing_started',
        fromState: FeatureExecutionState.CHANGES_REQUESTED,
        toState: FeatureExecutionState.FIXING,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.fixing_started',
        payload: { featureRunId, projectId },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.FIXING,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
