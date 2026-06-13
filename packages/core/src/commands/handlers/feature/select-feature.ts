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
  writeIdempotencyKey,
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
}
interface WorkflowStateRow {
  id: string;
  automation_state: string;
  active_feature_run_id: string | null;
  version: number;
}

export class SelectFeatureHandler implements CommandHandler<
  SelectFeaturePayload,
  FeatureExecutionState
> {
  readonly commandName = 'SelectFeatureCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly idempotencyScope = 'select-feature';

  async execute(
    envelope: CommandEnvelope<SelectFeaturePayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion } = envelope.payload;

    return db.transaction(async (tx) => {
      // Finding 5: include project_id in the query to prevent cross-project access
      const runs = await tx.query<FeatureRunRow>(
        `SELECT id, current_execution_state, version FROM feature_runs WHERE id = ? AND project_id = ?`,
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

      const newVersion = nextVersion(run.version);
      const now = isoNow();

      // Finding 2: use executeAffected for CAS verification
      const featureAffected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [FeatureExecutionState.SELECTED, newVersion, now, featureRunId, expectedVersion],
      );
      if (featureAffected === 0) {
        throw new OptimisticLockError('feature_runs', featureRunId, expectedVersion, -1);
      }

      // Finding 3: atomic conditional UPDATE on workflow_states to prevent race
      const wsAffected = await tx.executeAffected(
        `UPDATE workflow_states SET active_feature_run_id = ?, version = version + 1, updated_at = ?
         WHERE project_id = ? AND automation_state = 'running' AND active_feature_run_id IS NULL`,
        [featureRunId, now, projectId],
      );
      if (wsAffected === 0) {
        // Read to give a precise error
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

      await writeIdempotencyKey(tx, {
        key: envelope.idempotencyKey,
        scope: this.idempotencyScope,
        result,
        ttlMs: IDEMPOTENCY_TTL_MS,
      });

      return result;
    });
  }
}
