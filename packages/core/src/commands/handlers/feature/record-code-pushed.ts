import { z } from 'zod';
import { FeatureExecutionState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { FEATURE_EXECUTION_MATRIX } from '../../../statemachine/machines/feature-execution.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import { isoNow, writeWorkflowEvent, writeOutboxEvent, writeIdempotencyKey } from '../../helpers.js';

export const RecordCodePushedPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  commitSha: z.string().min(1),
});
export type RecordCodePushedPayload = z.infer<typeof RecordCodePushedPayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const ALLOWED_FROM = new Set<FeatureExecutionState>([FeatureExecutionState.CODING, FeatureExecutionState.FIXING]);
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow { id: string; current_execution_state: string; version: number; }

export class RecordCodePushedHandler implements CommandHandler<RecordCodePushedPayload, FeatureExecutionState> {
  readonly commandName = 'RecordCodePushedCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly idempotencyScope = 'record-code-pushed';

  async execute(envelope: CommandEnvelope<RecordCodePushedPayload>, db: DbClient): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion, commitSha } = envelope.payload;
    return db.transaction(async (tx) => {
      const rows = await tx.query<FeatureRunRow>(`SELECT id, current_execution_state, version FROM feature_runs WHERE id = ?`, [featureRunId]);
      const run = rows[0];
      assertVersion('feature_runs', featureRunId, run, expectedVersion);
      const fromState = run.current_execution_state as FeatureExecutionState;
      if (!ALLOWED_FROM.has(fromState)) {
        validator.assertValid(fromState, FeatureExecutionState.CODE_PUSHED);
      }
      validator.assertValid(fromState, FeatureExecutionState.CODE_PUSHED);
      const now = isoNow();
      await tx.execute(`UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`, [FeatureExecutionState.CODE_PUSHED, nextVersion(run.version), now, featureRunId, expectedVersion]);
      const eventId = await writeWorkflowEvent(tx, { featureRunId, projectId, eventType: 'feature.code_pushed', fromState, toState: FeatureExecutionState.CODE_PUSHED, actorId: envelope.actor.id, correlationId: envelope.correlationId });
      await writeOutboxEvent(tx, { eventType: 'feature.code_pushed', payload: { featureRunId, projectId, commitSha } });
      const result: CommandResult<FeatureExecutionState> = { commandId: envelope.commandId, accepted: true, resultingState: FeatureExecutionState.CODE_PUSHED, emittedEventIds: [eventId] };
      await writeIdempotencyKey(tx, { key: envelope.idempotencyKey, scope: this.idempotencyScope, result, ttlMs: IDEMPOTENCY_TTL_MS });
      return result;
    });
  }
}
