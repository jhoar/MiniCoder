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
import { evaluateMergeGate } from '../../../merge-gate/evaluate-merge-gate.js';

export const MergeIfReadyPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type MergeIfReadyPayload = z.infer<typeof MergeIfReadyPayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  feature_request_id: string;
  current_execution_state: string;
  version: number;
}

/**
 * The `approved_by_policy -> merge_ready` transition, initiated by an `approver`/`admin` via
 * `minicoder merge merge-if-ready` (docs/01 §12: "the actual merge is initiated by an
 * approver/admin via merge-if-ready, which re-evaluates the full gate immediately before
 * invoking GitHub"). This is the re-evaluation — the caller (the CLI command) only calls the
 * real GitHub merge API and dispatches `RecordMergedCommand`/`RecordMergeFailedCommand` after
 * this transition accepts, so nothing between the original `approved_by_policy` computation and
 * the real merge attempt goes unchecked (a budget breach, a new blocking finding, or a label
 * added in between all re-block here).
 *
 * Same two-phase evidence-then-transition shape as `RecordApprovedByPolicyHandler` — see that
 * handler's doc comment for why a single atomic transaction would lose the evidence record on a
 * rejected re-evaluation.
 */
export class MergeIfReadyHandler implements CommandHandler<
  MergeIfReadyPayload,
  FeatureExecutionState
> {
  readonly commandName = 'MergeIfReadyCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'merge-if-ready';

  async execute(
    envelope: CommandEnvelope<MergeIfReadyPayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion } = envelope.payload;

    const { evaluation } = await db.transaction(async (tx) => {
      const rows = await tx.query<FeatureRunRow>(
        `SELECT fr.id, fr.feature_request_id, fr.current_execution_state, fr.version
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
      const evaluation = await evaluateMergeGate(tx, {
        featureRunId,
        projectId,
        featureRequestId: run.feature_request_id,
      });
      return { run, evaluation };
    });

    if (evaluation.decision !== 'approved') {
      throw new CommandError({
        type: 'merge-gate-blocked',
        title: 'Merge gate did not pass on re-evaluation',
        status: 409,
        detail: `Merge gate rejected feature run ${featureRunId}: ${evaluation.reasons.join('; ')}`,
        instance: envelope.correlationId,
      });
    }

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<FeatureExecutionState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const rows = await tx.query<FeatureRunRow>(
        `SELECT fr.id, fr.feature_request_id, fr.current_execution_state, fr.version
         FROM feature_runs fr
         JOIN feature_requests freq ON fr.feature_request_id = freq.id
         WHERE fr.id = ? AND freq.project_id = ?`,
        [featureRunId, projectId],
      );
      const run = rows[0];
      assertVersion('feature_runs', featureRunId, run, expectedVersion);
      const fromState = run.current_execution_state as FeatureExecutionState;
      validator.assertValid(fromState, FeatureExecutionState.MERGE_READY);

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.MERGE_READY,
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
        eventType: 'feature.merge_ready',
        fromState,
        toState: FeatureExecutionState.MERGE_READY,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.merge_ready',
        payload: { featureRunId, projectId, mergeGateEvaluationId: evaluation.evaluationId },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.MERGE_READY,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
