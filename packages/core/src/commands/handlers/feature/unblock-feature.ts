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
} from '../../helpers.js';

export const UnblockFeaturePayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type UnblockFeaturePayload = z.infer<typeof UnblockFeaturePayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
  feature_request_id: string;
}

/**
 * blocked -> approved_pending_execution. No lock-fence requirement per the matrix — a blocked
 * feature run isn't holding the execution lane. Built in Phase 8 but has no caller yet: nothing
 * in Phase 8 ever transitions a feature run to 'blocked' in the first place.
 */
export class UnblockFeatureHandler implements CommandHandler<
  UnblockFeaturePayload,
  FeatureExecutionState
> {
  readonly commandName = 'UnblockFeatureCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'unblock-feature';

  async execute(
    envelope: CommandEnvelope<UnblockFeaturePayload>,
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

      const rows = await tx.query<FeatureRunRow>(
        `SELECT fr.id, fr.current_execution_state, fr.version, freq.id as feature_request_id
         FROM feature_runs fr
         JOIN feature_requests freq ON fr.feature_request_id = freq.id
         WHERE fr.id = ? AND freq.project_id = ?`,
        [featureRunId, projectId],
      );
      const run = rows[0];
      if (!run) {
        throw new CommandError({
          type: 'not-found',
          title: 'Feature run not found',
          status: 404,
          detail: `Feature run ${featureRunId} not found in project ${projectId}`,
          instance: envelope.correlationId,
        });
      }
      assertVersion('feature_runs', featureRunId, run, expectedVersion);
      validator.assertValid(
        run.current_execution_state as FeatureExecutionState,
        FeatureExecutionState.APPROVED_PENDING_EXECUTION,
      );

      // Guard: all blocking dependencies must now be merged (same shape as SelectFeatureHandler).
      const unmetDeps = await tx.query<{ id: string }>(
        `SELECT fd.id
         FROM feature_dependencies fd
         WHERE fd.source_fr_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM feature_runs fr
             WHERE fr.feature_request_id = fd.target_fr_id
               AND fr.current_execution_state = 'merged'
           )`,
        [run.feature_request_id],
      );
      if (unmetDeps.length > 0) {
        throw new CommandError({
          type: 'unmet-dependencies',
          title: 'Feature has unmet dependencies',
          status: 409,
          detail: `Cannot unblock feature: ${unmetDeps.length} dependency(ies) not yet merged`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.APPROVED_PENDING_EXECUTION,
          nextVersion(run.version),
          now,
          featureRunId,
          expectedVersion,
        ],
      );
      if (affected === 0) {
        throw new OptimisticLockError('feature_runs', featureRunId, expectedVersion, -1);
      }
      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'feature.unblocked',
        fromState: FeatureExecutionState.BLOCKED,
        toState: FeatureExecutionState.APPROVED_PENDING_EXECUTION,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.unblocked',
        payload: { featureRunId, projectId },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.APPROVED_PENDING_EXECUTION,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
