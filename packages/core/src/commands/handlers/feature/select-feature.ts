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

export const SelectFeaturePayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type SelectFeaturePayload = z.infer<typeof SelectFeaturePayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
  feature_request_id: string;
}

export class SelectFeatureHandler implements CommandHandler<
  SelectFeaturePayload,
  FeatureExecutionState
> {
  readonly commandName = 'SelectFeatureCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'select-feature';

  async execute(
    envelope: CommandEnvelope<SelectFeaturePayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<FeatureExecutionState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      // Join through feature_requests to enforce project_id (feature_runs has no project_id column)
      const runs = await tx.query<FeatureRunRow>(
        `SELECT fr.id, fr.current_execution_state, fr.version, freq.id as feature_request_id
         FROM feature_runs fr
         JOIN feature_requests freq ON fr.feature_request_id = freq.id
         WHERE fr.id = ? AND freq.project_id = ?`,
        [featureRunId, projectId],
      );
      const run = runs[0];
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

      // Dependency guard: all dependencies must be merged before selection
      const unmetDeps = await tx.query<{ id: string }>(
        `SELECT fd.id
         FROM feature_dependencies fd
         JOIN feature_requests dep ON fd.target_fr_id = dep.id
         WHERE fd.source_fr_id = ? AND dep.state != 'merged'`,
        [run.feature_request_id],
      );
      if (unmetDeps.length > 0) {
        throw new CommandError({
          type: 'unmet-dependencies',
          title: 'Feature has unmet dependencies',
          status: 409,
          detail: `Cannot select feature: ${unmetDeps.length} dependency(ies) not yet merged`,
          instance: envelope.correlationId,
        });
      }

      const newVersion = nextVersion(run.version);
      const now = isoNow();

      const featureAffected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [FeatureExecutionState.SELECTED, newVersion, now, featureRunId, expectedVersion],
      );
      if (featureAffected === 0) {
        throw new OptimisticLockError('feature_runs', featureRunId, expectedVersion, -1);
      }

      // Atomic conditional UPDATE on workflow_states to prevent concurrent selection race
      const wsAffected = await tx.executeAffected(
        `UPDATE workflow_states SET active_feature_run_id = ?, version = version + 1, updated_at = ?
         WHERE project_id = ? AND automation_state = 'running' AND active_feature_run_id IS NULL`,
        [featureRunId, now, projectId],
      );
      if (wsAffected === 0) {
        const wsList = await tx.query<{
          automation_state: string;
          active_feature_run_id: string | null;
        }>(
          `SELECT automation_state, active_feature_run_id FROM workflow_states WHERE project_id = ?`,
          [projectId],
        );
        const ws = wsList[0];
        if (!ws || ws.automation_state !== 'running') {
          throw new CommandError({
            type: 'automation-paused',
            title: 'Automation is paused',
            status: 409,
            detail: `Cannot select feature: automation is ${ws?.automation_state ?? 'unknown'}`,
            instance: envelope.correlationId,
          });
        }
        throw new CommandError({
          type: 'feature-already-active',
          title: 'A feature run is already active',
          status: 409,
          detail: `Cannot select feature: active_feature_run_id is already set`,
          instance: envelope.correlationId,
        });
      }

      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'feature.selected',
        fromState: FeatureExecutionState.APPROVED_PENDING_EXECUTION,
        toState: FeatureExecutionState.SELECTED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });

      await writeOutboxEvent(tx, {
        eventType: 'feature.selected',
        payload: {
          featureRunId,
          projectId,
          fromState: 'approved_pending_execution',
          toState: 'selected',
        },
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
