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

export const RetryFeaturePayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  notes: z.string().min(1),
});
export type RetryFeaturePayload = z.infer<typeof RetryFeaturePayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
  feature_request_id: string;
}

/**
 * `human_required -> selected`. The generic, universal "try again" disposition — deliberately
 * returns to `selected` rather than trying to remember/reconstruct whatever stage the feature was
 * at before escalating (no column tracks that), so `start-next-feature`'s existing
 * `StartCodingCommand` hop re-drives coding from a clean, known-good starting point regardless of
 * why the feature reached `human_required` (a transient `system_failed`, a `failed` retry
 * exhaustion, a GitHub-reconciliation false positive, etc). Docs/06 Phase 11.
 */
export class RetryFeatureHandler implements CommandHandler<
  RetryFeaturePayload,
  FeatureExecutionState
> {
  readonly commandName = 'RetryFeatureCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'retry-feature';

  async execute(
    envelope: CommandEnvelope<RetryFeaturePayload>,
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
        FeatureExecutionState.SELECTED,
      );

      // Guard: this feature run must still be workflow_states.active_feature_run_id — retrying a
      // run that isn't the project's current active feature would land it at `selected` with no
      // active_feature_run_id pointer to it, so nothing (SelectFeatureHandler's CAS or
      // start-next-feature's stranded-selected-run check) would ever pick it up again, silently
      // orphaning it. Preserves the single-active-feature-per-project invariant (CLAUDE.md's
      // Execution Orchestrator Operational Constraints).
      const wsRows = await tx.query<{ active_feature_run_id: string | null }>(
        `SELECT active_feature_run_id FROM workflow_states WHERE project_id = ?`,
        [projectId],
      );
      if (wsRows[0]?.active_feature_run_id !== featureRunId) {
        throw new CommandError({
          type: 'not-active-feature-run',
          title: 'Feature run is not the project’s active feature',
          status: 409,
          detail: `Feature run ${featureRunId} is not workflow_states.active_feature_run_id for project ${projectId}; retry only applies to the currently active feature`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.SELECTED,
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
        contextType: 'human_escalation_resolution',
        decision: 'approved',
        actor: envelope.actor.id,
        actorRole: envelope.actor.role,
        notes,
      });
      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'feature.retried',
        fromState: FeatureExecutionState.HUMAN_REQUIRED,
        toState: FeatureExecutionState.SELECTED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.retried',
        payload: { featureRunId, projectId },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.SELECTED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
