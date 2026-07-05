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
import {
  evaluateMergeGate,
  MergeGateBlockedError,
} from '../../../merge-gate/evaluate-merge-gate.js';

export const RecordApprovedByPolicyPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type RecordApprovedByPolicyPayload = z.infer<typeof RecordApprovedByPolicyPayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  feature_request_id: string;
  current_execution_state: string;
  version: number;
}

/**
 * The `under_review -> approved_by_policy` transition (docs/01 §12, docs/06 Phase 12).
 *
 * Two-phase, not one atomic transaction: `evaluateMergeGate` runs first, in its *own* transaction,
 * and always commits a `merge_gate_evaluations` evidence row — win or lose — because "every
 * merge-gate run writes a structured record" (docs/01 §12) must hold even when the gate rejects.
 * A single all-or-nothing transaction covering both the evaluation and the transition would roll
 * the evidence write back along with the (deliberately not taken) transition on a rejection,
 * silently losing the audit trail for every blocked attempt. The second transaction only runs
 * when the gate passes, and owns the actual state transition plus its own idempotency claim (the
 * evaluation phase is safe to repeat on retry — it only ever appends a fresh audit row, matching
 * the append-only convention already established for `adapter_conformance_results`).
 */
export class RecordApprovedByPolicyHandler implements CommandHandler<
  RecordApprovedByPolicyPayload,
  FeatureExecutionState
> {
  readonly commandName = 'RecordApprovedByPolicyCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'record-approved-by-policy';

  async execute(
    envelope: CommandEnvelope<RecordApprovedByPolicyPayload>,
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
      throw new MergeGateBlockedError(evaluation.reasons, featureRunId, envelope.correlationId);
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
      validator.assertValid(fromState, FeatureExecutionState.APPROVED_BY_POLICY);

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.APPROVED_BY_POLICY,
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
        eventType: 'feature.approved_by_policy',
        fromState,
        toState: FeatureExecutionState.APPROVED_BY_POLICY,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.approved_by_policy',
        payload: { featureRunId, projectId, mergeGateEvaluationId: evaluation.evaluationId },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.APPROVED_BY_POLICY,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
