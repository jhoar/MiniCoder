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
 * feature. If this feature run is the project's current active feature, the
 * `workflow_states.active_feature_run_id` pointer is cleared so `start-next-feature` can select a
 * different feature next (mirroring `RecordMergedCommand`'s `clear_active_feature_run` side
 * effect).
 *
 * A skipped feature never reaches `merged`, so any downstream feature depending on it
 * (`feature_dependencies` requiring `merged`) would otherwise be silently stuck at
 * `approved_pending_execution` forever (issue #52) — `SelectFeatureHandler`'s dependency guard
 * would simply never clear, with no error or visible signal. Fixed by cascading: in the same
 * transaction, every dependent feature run still at `approved_pending_execution` is transitioned
 * to `blocked` (a new matrix row, `approved_pending_execution -> blocked` triggered by
 * `SkipFeatureCommand`), so the problem is immediately visible via the existing `blocked`-state
 * diagnostics rather than requiring a human to notice a feature never becomes eligible.
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

      // Cascade: block every still-pending dependent so it doesn't silently strand forever
      // waiting on a dependency that can now never reach 'merged' (issue #52).
      const dependents = await tx.query<{ id: string; version: number }>(
        `SELECT fr.id, fr.version
         FROM feature_dependencies fd
         JOIN feature_runs fr ON fr.feature_request_id = fd.source_fr_id
         WHERE fd.target_fr_id = ?
           AND fr.current_execution_state = ?`,
        [run.feature_request_id, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
      );
      for (const dependent of dependents) {
        validator.assertValid(
          FeatureExecutionState.APPROVED_PENDING_EXECUTION,
          FeatureExecutionState.BLOCKED,
        );
        const dependentNow = isoNow();
        // Post-merge review fix: use executeAffected (not a bare execute) so a concurrent version
        // change on this dependent between the SELECT above and this UPDATE is detected — the
        // predicate's own `AND version = ?` would otherwise silently affect 0 rows while the
        // workflow/outbox events below were still written unconditionally, falsely claiming a
        // transition that never happened. Skip event emission entirely on a CAS miss rather than
        // failing the whole SkipFeatureCommand — the dependent's actual current state (whatever
        // the concurrent writer set it to) is authoritative, and a later skip/reconcile pass (or
        // this same cascade re-running against a fresh version) can still catch it if it's still
        // eligible.
        const dependentAffected = await tx.executeAffected(
          `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
          [
            FeatureExecutionState.BLOCKED,
            nextVersion(dependent.version),
            dependentNow,
            dependent.id,
            dependent.version,
          ],
        );
        if (dependentAffected === 0) {
          continue;
        }
        await writeWorkflowEvent(tx, {
          featureRunId: dependent.id,
          projectId,
          eventType: 'feature.blocked_by_skipped_dependency',
          fromState: FeatureExecutionState.APPROVED_PENDING_EXECUTION,
          toState: FeatureExecutionState.BLOCKED,
          actorId: envelope.actor.id,
          correlationId: envelope.correlationId,
        });
        await writeOutboxEvent(tx, {
          eventType: 'feature.blocked_by_skipped_dependency',
          payload: { featureRunId: dependent.id, projectId, skippedFeatureRunId: featureRunId },
        });
      }

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
