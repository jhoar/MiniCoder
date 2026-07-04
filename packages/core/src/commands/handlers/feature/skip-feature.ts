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
  insertHumanApproval,
} from '../../helpers.js';

export const SkipFeaturePayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  notes: z.string().min(1),
});
export type SkipFeaturePayload = z.infer<typeof SkipFeaturePayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
  feature_request_id: string;
}

/**
 * `human_required -> skipped` (terminal). The human explicitly abandons automation for this
 * feature. Docs/06 Phase 11 known limitation: a skipped feature never reaches `merged`, so any
 * downstream feature depending on it (`feature_dependencies` requiring `merged`) will never clear
 * its dependency guard automatically — resolving that is out of this phase's scope (the same
 * "documented, not solved" posture this codebase uses elsewhere for cross-cutting consequences of
 * a deliberate human decision). If this feature run is the project's current active feature, the
 * `workflow_states.active_feature_run_id` pointer is cleared so `start-next-feature` can select a
 * different feature next (mirroring `RecordMergedCommand`'s `clear_active_feature_run` side
 * effect).
 */
export class SkipFeatureHandler implements CommandHandler<
  SkipFeaturePayload,
  FeatureExecutionState
> {
  readonly commandName = 'SkipFeatureCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'skip-feature';

  async execute(
    envelope: CommandEnvelope<SkipFeaturePayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion, notes } = envelope.payload;
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
        FeatureExecutionState.SKIPPED,
      );

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.SKIPPED,
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
        `UPDATE workflow_states SET active_feature_run_id = NULL, version = version + 1, updated_at = ?
         WHERE project_id = ? AND active_feature_run_id = ?`,
        [now, projectId, featureRunId],
      );
      await insertHumanApproval(tx, {
        projectId,
        featureRequestId: run.feature_request_id,
        featureRunId,
        contextType: 'human_escalation_resolution',
        decision: 'rejected',
        actor: envelope.actor.id,
        actorRole: envelope.actor.role,
        notes,
      });
      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'feature.skipped',
        fromState: FeatureExecutionState.HUMAN_REQUIRED,
        toState: FeatureExecutionState.SKIPPED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.skipped',
        payload: { featureRunId, projectId },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.SKIPPED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
