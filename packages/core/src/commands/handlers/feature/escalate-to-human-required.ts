import { z } from 'zod';
import { FeatureExecutionState, UserRole } from '../../../domain/states.js';
import { FEATURE_EXECUTION_MATRIX } from '../../../statemachine/machines/feature-execution.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
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

export const EscalateToHumanPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().min(1),
});
export type EscalateToHumanPayload = z.infer<typeof EscalateToHumanPayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
}

export class EscalateToHumanHandler implements CommandHandler<
  EscalateToHumanPayload,
  FeatureExecutionState
> {
  readonly commandName = 'EscalateToHumanCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'escalate-to-human';

  async execute(
    envelope: CommandEnvelope<EscalateToHumanPayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion, reason } = envelope.payload;
    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<FeatureExecutionState>(
        tx, envelope.idempotencyKey, this.idempotencyScope, IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      // Join through feature_requests to enforce project_id (feature_runs has no project_id column)
      const rows = await tx.query<FeatureRunRow>(
        `SELECT fr.id, fr.current_execution_state, fr.version
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
      const fromState = run.current_execution_state as FeatureExecutionState;
      validator.assertValid(fromState, FeatureExecutionState.HUMAN_REQUIRED);
      const now = isoNow();
      const escalateAffected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [FeatureExecutionState.HUMAN_REQUIRED, nextVersion(run.version), now, featureRunId, expectedVersion],
      );
      if (escalateAffected === 0) {
        throw new OptimisticLockError('feature_runs', featureRunId, expectedVersion, -1);
      }
      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'feature.human_required',
        fromState,
        toState: FeatureExecutionState.HUMAN_REQUIRED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.human_required',
        payload: { featureRunId, projectId, reason },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.HUMAN_REQUIRED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
