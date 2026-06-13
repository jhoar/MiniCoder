import { z } from 'zod';
import { FeatureExecutionState, UserRole } from '../../../domain/states.js';
import { FEATURE_EXECUTION_MATRIX } from '../../../statemachine/machines/feature-execution.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import {
  isoNow,
  writeWorkflowEvent,
  writeOutboxEvent,
  writeIdempotencyKey,
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
  readonly idempotencyScope = 'escalate-to-human';

  async execute(
    envelope: CommandEnvelope<EscalateToHumanPayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion, reason } = envelope.payload;
    return db.transaction(async (tx) => {
      const rows = await tx.query<FeatureRunRow>(
        `SELECT id, current_execution_state, version FROM feature_runs WHERE id = ?`,
        [featureRunId],
      );
      const run = rows[0];
      assertVersion('feature_runs', featureRunId, run, expectedVersion);
      const fromState = run.current_execution_state as FeatureExecutionState;
      validator.assertValid(fromState, FeatureExecutionState.HUMAN_REQUIRED);
      const now = isoNow();
      await tx.execute(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.HUMAN_REQUIRED,
          nextVersion(run.version),
          now,
          featureRunId,
          expectedVersion,
        ],
      );
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
      await writeIdempotencyKey(tx, {
        key: envelope.idempotencyKey,
        scope: this.idempotencyScope,
        result,
        ttlMs: IDEMPOTENCY_TTL_MS,
      });
      return result;
    });
  }
}
