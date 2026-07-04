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

export const RecordMergedPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  mergeSha: z.string().min(1),
});
export type RecordMergedPayload = z.infer<typeof RecordMergedPayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
}

/**
 * The `merge_ready -> merged` transition: records the GitHub-confirmed merge commit SHA onto
 * `pull_requests` and clears `workflow_states.active_feature_run_id` (mirroring
 * `SkipFeatureHandler`/`BlockFeatureHandler`'s identical clear, so `start-next-feature` can
 * select a different feature for the project next — the "next feature starts only after merge"
 * acceptance criterion). The real GitHub merge call and the branch between `RecordMergedCommand`
 * and `RecordMergeFailedCommand` are the caller's responsibility (`minicoder merge merge-if-ready`
 * — see docs/06 Phase 12); this handler only records an already-confirmed outcome.
 */
export class RecordMergedHandler implements CommandHandler<
  RecordMergedPayload,
  FeatureExecutionState
> {
  readonly commandName = 'RecordMergedCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'record-merged';

  async execute(
    envelope: CommandEnvelope<RecordMergedPayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion, mergeSha } = envelope.payload;
    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<FeatureExecutionState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

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
      validator.assertValid(fromState, FeatureExecutionState.MERGED);

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.MERGED,
          nextVersion(run.version),
          now,
          featureRunId,
          expectedVersion,
        ],
      );
      if (affected === 0) {
        throw new OptimisticLockError('feature_runs', featureRunId, expectedVersion, -1);
      }
      await tx.execute(
        `UPDATE pull_requests SET state = 'merged', merge_sha = ?, merged_at = ?, version = version + 1, updated_at = ?
         WHERE feature_run_id = ?`,
        [mergeSha, now, now, featureRunId],
      );
      await tx.execute(
        `UPDATE workflow_states SET active_feature_run_id = NULL, version = version + 1, updated_at = ?
         WHERE project_id = ? AND active_feature_run_id = ?`,
        [now, projectId, featureRunId],
      );
      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'feature.merged',
        fromState,
        toState: FeatureExecutionState.MERGED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.merged',
        payload: { featureRunId, projectId, mergeSha },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.MERGED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
