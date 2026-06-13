import { z } from 'zod';
import { FeatureExecutionState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { FEATURE_EXECUTION_MATRIX } from '../../../statemachine/machines/feature-execution.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import { isoNow, writeWorkflowEvent, writeOutboxEvent, writeIdempotencyKey } from '../../helpers.js';

export const StartCodingPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type StartCodingPayload = z.infer<typeof StartCodingPayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow { id: string; current_execution_state: string; version: number; }

export class StartCodingHandler implements CommandHandler<StartCodingPayload, FeatureExecutionState> {
  readonly commandName = 'StartCodingCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly idempotencyScope = 'start-coding';

  async execute(envelope: CommandEnvelope<StartCodingPayload>, db: DbClient): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion } = envelope.payload;
    return db.transaction(async (tx) => {
      const rows = await tx.query<FeatureRunRow>(`SELECT id, current_execution_state, version FROM feature_runs WHERE id = ?`, [featureRunId]);
      const run = rows[0];
      assertVersion('feature_runs', featureRunId, run, expectedVersion);
      validator.assertValid(run.current_execution_state as FeatureExecutionState, FeatureExecutionState.CODING);
      const now = isoNow();
      await tx.execute(`UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`, [FeatureExecutionState.CODING, nextVersion(run.version), now, featureRunId, expectedVersion]);
      const eventId = await writeWorkflowEvent(tx, { featureRunId, projectId, eventType: 'feature.coding_started', fromState: FeatureExecutionState.SELECTED, toState: FeatureExecutionState.CODING, actorId: envelope.actor.id, correlationId: envelope.correlationId });
      await writeOutboxEvent(tx, { eventType: 'feature.coding_started', payload: { featureRunId, projectId } });
      const result: CommandResult<FeatureExecutionState> = { commandId: envelope.commandId, accepted: true, resultingState: FeatureExecutionState.CODING, emittedEventIds: [eventId] };
      await writeIdempotencyKey(tx, { key: envelope.idempotencyKey, scope: this.idempotencyScope, result, ttlMs: IDEMPOTENCY_TTL_MS });
      return result;
    });
  }
}
