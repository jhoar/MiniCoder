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
import { resolveDisagreementByHuman } from '../../../disagreement/write.js';

export const ResumeFeatureExecutionPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  notes: z.string().min(1),
  // Set when this resume dispositions an open disagreement in the coder's favor (the finding is
  // dismissed, no fix needed) rather than resuming from an unrelated human_required escalation
  // (a GitHub-reconciliation false-positive, a manually-cleared merge_failed, etc).
  disagreementId: z.string().optional(),
});
export type ResumeFeatureExecutionPayload = z.infer<typeof ResumeFeatureExecutionPayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
  feature_request_id: string;
}

/**
 * `human_required -> under_review`. Used when the escalation is dismissed without requiring a
 * code change — e.g. a disagreement resolved in the coder's favor (`coder_correct`), a
 * GitHub-reconciliation divergence that turns out to be a false positive, or a `merge_failed`
 * escalation cleared by hand. Docs/06 Phase 11.
 */
export class ResumeFeatureExecutionHandler implements CommandHandler<
  ResumeFeatureExecutionPayload,
  FeatureExecutionState
> {
  readonly commandName = 'ResumeFeatureExecutionCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'resume-feature-execution';

  async execute(
    envelope: CommandEnvelope<ResumeFeatureExecutionPayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion, notes, disagreementId } = envelope.payload;
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
        FeatureExecutionState.UNDER_REVIEW,
      );

      if (disagreementId) {
        await resolveDisagreementByHuman(tx, { disagreementId, resolution: notes });
      }

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.UNDER_REVIEW,
          nextVersion(run.version),
          now,
          featureRunId,
          expectedVersion,
        ],
      );
      if (affected === 0) {
        throw new OptimisticLockError('feature_runs', featureRunId, expectedVersion, -1);
      }
      await insertHumanApproval(tx, {
        projectId,
        featureRequestId: run.feature_request_id,
        featureRunId,
        contextType: disagreementId ? 'disagreement_resolution' : 'human_escalation_resolution',
        contextId: disagreementId,
        decision: 'approved',
        actor: envelope.actor.id,
        actorRole: envelope.actor.role,
        notes,
      });
      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'feature.resumed_from_human_required',
        fromState: FeatureExecutionState.HUMAN_REQUIRED,
        toState: FeatureExecutionState.UNDER_REVIEW,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.resumed_from_human_required',
        payload: { featureRunId, projectId },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.UNDER_REVIEW,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
