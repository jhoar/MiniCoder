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

export const RecordCodePushedPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  commitSha: z.string().min(1),
});
export type RecordCodePushedPayload = z.infer<typeof RecordCodePushedPayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
}

export class RecordCodePushedHandler implements CommandHandler<
  RecordCodePushedPayload,
  FeatureExecutionState
> {
  readonly commandName = 'RecordCodePushedCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'record-code-pushed';

  async execute(
    envelope: CommandEnvelope<RecordCodePushedPayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion, commitSha } = envelope.payload;
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
      await assertLockFence(tx, envelope.lockContext);

      const rows = await tx.query<FeatureRunRow>(
        `SELECT fr.id, fr.current_execution_state, fr.version
         FROM feature_runs fr
         JOIN feature_requests freq ON fr.feature_request_id = freq.id
         WHERE fr.id = ? AND freq.project_id = ?`,
        [featureRunId, projectId],
      );
      const run = rows[0];
      assertVersion('feature_runs', featureRunId, run, expectedVersion);
      const fromState = run.current_execution_state as FeatureExecutionState;
      validator.assertValid(fromState, FeatureExecutionState.CODE_PUSHED);
      const now = isoNow();
      const codePushedAffected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.CODE_PUSHED,
          nextVersion(run.version),
          now,
          featureRunId,
          expectedVersion,
        ],
      );
      if (codePushedAffected === 0) {
        throw new OptimisticLockError('feature_runs', featureRunId, expectedVersion, -1);
      }
      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'feature.code_pushed',
        fromState,
        toState: FeatureExecutionState.CODE_PUSHED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.code_pushed',
        payload: { featureRunId, projectId, commitSha },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.CODE_PUSHED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
