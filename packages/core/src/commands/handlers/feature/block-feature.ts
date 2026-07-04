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

export const BlockFeaturePayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  notes: z.string().min(1),
});
export type BlockFeaturePayload = z.infer<typeof BlockFeaturePayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
  feature_request_id: string;
}

/**
 * `human_required -> blocked`, human-initiated (distinct from `UnblockFeatureCommand`'s
 * counterpart, `BLOCKED -> APPROVED_PENDING_EXECUTION`, which is the *automatic*
 * dependency-cleared path from Phase 8). A human here identifies some external precondition that
 * must be satisfied before automation resumes.
 *
 * Known limitation (docs/06 Phase 11): `UnblockFeatureCommand`'s guard checks
 * `feature_dependencies`, not "a human said this is unblocked now" — a feature blocked this way
 * with no unmet dependency will never satisfy that guard automatically. Until a dedicated
 * human-driven unblock command exists, `RetryFeatureCommand` is not reachable from `blocked`
 * either (it only accepts `human_required` as its `fromState`) — recovering a human-blocked
 * feature currently requires a direct state-repair (`minicoder state repair`), the same posture
 * this codebase already accepts for other orphaned-handler gaps (e.g. `UnblockFeatureHandler`
 * itself sat uncalled from Phase 8 through Phase 10).
 */
export class BlockFeatureHandler implements CommandHandler<
  BlockFeaturePayload,
  FeatureExecutionState
> {
  readonly commandName = 'BlockFeatureCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'block-feature';

  async execute(
    envelope: CommandEnvelope<BlockFeaturePayload>,
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
        FeatureExecutionState.BLOCKED,
      );

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.BLOCKED,
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
        decision: 'deferred',
        actor: envelope.actor.id,
        actorRole: envelope.actor.role,
        notes,
      });
      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'feature.blocked_by_human',
        fromState: FeatureExecutionState.HUMAN_REQUIRED,
        toState: FeatureExecutionState.BLOCKED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.blocked_by_human',
        payload: { featureRunId, projectId },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.BLOCKED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
