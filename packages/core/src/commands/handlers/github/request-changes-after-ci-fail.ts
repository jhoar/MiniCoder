import { z } from 'zod';
import { FeatureExecutionState, UserRole } from '../../../domain/states.js';
import { FIX_ATTEMPT_THRESHOLD } from '../../../domain/constants.js';
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

export const RequestChangesAfterCiFailPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type RequestChangesAfterCiFailPayload = z.infer<
  typeof RequestChangesAfterCiFailPayloadSchema
>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
  fix_attempt_count: number;
}

/**
 * ci_failed -> changes_requested (Phase 10 — Review/Fix Loop). Follows
 * RecordChangesRequestedHandler/RecordCiFailedHandler's shape exactly. Guard: `fix_attempt_count
 * < FIX_ATTEMPT_THRESHOLD`; a caller (`reconcileGithubState()`) should check this itself before
 * dispatching (dispatching `EscalateToHumanCommand` instead when at/over threshold), but the
 * handler enforces it too as defense-in-depth. Side effect: increment `fix_attempt_count` (the
 * matrix's `increment_fix_attempt_count`).
 */
export class RequestChangesAfterCiFailHandler implements CommandHandler<
  RequestChangesAfterCiFailPayload,
  FeatureExecutionState
> {
  readonly commandName = 'RequestChangesAfterCiFailCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'request-changes-after-ci-fail';

  async execute(
    envelope: CommandEnvelope<RequestChangesAfterCiFailPayload>,
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
        `SELECT fr.id, fr.current_execution_state, fr.version, fr.fix_attempt_count
         FROM feature_runs fr
         JOIN feature_requests freq ON fr.feature_request_id = freq.id
         WHERE fr.id = ? AND freq.project_id = ?`,
        [featureRunId, projectId],
      );
      const run = rows[0];
      assertVersion('feature_runs', featureRunId, run, expectedVersion);
      const fromState = run.current_execution_state as FeatureExecutionState;
      validator.assertValid(fromState, FeatureExecutionState.CHANGES_REQUESTED);

      if (run.fix_attempt_count >= FIX_ATTEMPT_THRESHOLD) {
        throw new CommandError({
          type: 'fix-attempt-limit-exceeded',
          title: 'Fix-attempt threshold exceeded',
          status: 409,
          detail: `Feature run ${featureRunId} has reached the fix-attempt threshold (${FIX_ATTEMPT_THRESHOLD}); dispatch EscalateToHumanCommand instead`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, fix_attempt_count = fix_attempt_count + 1, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.CHANGES_REQUESTED,
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
        eventType: 'github.changes_requested_after_ci_fail',
        fromState,
        toState: FeatureExecutionState.CHANGES_REQUESTED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      // Matches FeatureChangesRequestedPayloadSchema's required shape (reviewId/reviewer) —
      // there is no GitHub review here, only a CI failure, so reviewId is a synthetic marker.
      await writeOutboxEvent(tx, {
        eventType: 'feature.changes_requested',
        payload: { featureRunId, projectId, reviewId: `ci-failed:${featureRunId}`, reviewer: null },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.CHANGES_REQUESTED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
