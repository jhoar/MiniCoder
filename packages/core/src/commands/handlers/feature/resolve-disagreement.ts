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
import {
  findDisagreementForFeatureRun,
  resolveDisagreementByHuman,
} from '../../../disagreement/write.js';

export const ResolveDisagreementPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  resolution: z.string().min(1),
  // Optional: caller already knows which disagreement_records row this resolves. When omitted,
  // the handler resolves the feature run's most recent open disagreement.
  disagreementId: z.string().optional(),
});
export type ResolveDisagreementPayload = z.infer<typeof ResolveDisagreementPayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
  feature_request_id: string;
}

/**
 * `human_required -> changes_requested`. The human (or the Arbiter, via a prior `run-review.ts`
 * invocation that couldn't resolve the disagreement itself) has determined the reviewer's finding
 * stands and the coder must implement a fix — docs/06 Phase 11. Requires an open
 * `disagreement_records` row for this feature run; a human_required escalation unrelated to any
 * disagreement (e.g. a plain GitHub-reconciliation divergence) has no such row and must use
 * `RetryFeatureCommand`/`ResumeFeatureExecutionCommand` instead.
 */
export class ResolveDisagreementHandler implements CommandHandler<
  ResolveDisagreementPayload,
  FeatureExecutionState
> {
  readonly commandName = 'ResolveDisagreementCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'resolve-disagreement';

  async execute(
    envelope: CommandEnvelope<ResolveDisagreementPayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion, resolution, disagreementId } =
      envelope.payload;
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
        FeatureExecutionState.CHANGES_REQUESTED,
      );

      // HIGH code-review fix: a caller-supplied disagreementId must be validated against this
      // feature run (and its open/escalated state) before being acted on — it was previously
      // trusted bare, so a bogus or another feature run's disagreement id would silently no-op
      // the resolve while this feature run's state transition proceeded anyway.
      const disagreement = await findDisagreementForFeatureRun(tx, {
        featureRunId,
        disagreementId,
      });
      if (!disagreement) {
        throw new CommandError({
          type: 'no-open-disagreement',
          title: 'No open disagreement to resolve',
          status: 409,
          detail: disagreementId
            ? `Disagreement ${disagreementId} is not an open/escalated disagreement for feature run ${featureRunId}`
            : `Feature run ${featureRunId} has no open disagreement_records row`,
          instance: envelope.correlationId,
        });
      }
      const resolvedAffected = await resolveDisagreementByHuman(tx, {
        disagreementId: disagreement.id,
        featureRunId,
        resolution,
      });
      if (resolvedAffected === 0) {
        throw new CommandError({
          type: 'no-open-disagreement',
          title: 'Disagreement was already resolved',
          status: 409,
          detail: `Disagreement ${disagreement.id} is no longer open/escalated`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.CHANGES_REQUESTED,
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
        contextType: 'disagreement_resolution',
        contextId: disagreement.id,
        decision: 'approved',
        actor: envelope.actor.id,
        actorRole: envelope.actor.role,
        notes: resolution,
      });
      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'feature.disagreement_resolved',
        fromState: FeatureExecutionState.HUMAN_REQUIRED,
        toState: FeatureExecutionState.CHANGES_REQUESTED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.disagreement_resolved',
        payload: { featureRunId, projectId, disagreementId: disagreement.id, resolution },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.CHANGES_REQUESTED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
