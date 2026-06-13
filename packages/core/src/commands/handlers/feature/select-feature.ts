import { z } from 'zod';
import { FeatureExecutionState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { FEATURE_EXECUTION_MATRIX } from '../../../statemachine/machines/feature-execution.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import { CommandError } from '../../types.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import {
  isoNow,
  writeWorkflowEvent, writeOutboxEvent, writeIdempotencyKey,
} from '../../helpers.js';

export const SelectFeaturePayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type SelectFeaturePayload = z.infer<typeof SelectFeaturePayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow { id: string; current_execution_state: string; version: number; }
interface WorkflowStateRow { id: string; automation_state: string; version: number; }

export class SelectFeatureHandler
  implements CommandHandler<SelectFeaturePayload, FeatureExecutionState>
{
  readonly commandName = 'SelectFeatureCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly idempotencyScope = 'select-feature';

  async execute(
    envelope: CommandEnvelope<SelectFeaturePayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion } = envelope.payload;

    return db.transaction(async (tx) => {
      const runs = await tx.query<FeatureRunRow>(
        `SELECT id, current_execution_state, version FROM feature_runs WHERE id = ?`,
        [featureRunId],
      );
      const run = runs[0];

      assertVersion('feature_runs', featureRunId, run, expectedVersion);
      validator.assertValid(
        run.current_execution_state as FeatureExecutionState,
        FeatureExecutionState.SELECTED,
      );

      const wsList = await tx.query<WorkflowStateRow>(
        `SELECT id, automation_state, version FROM workflow_states WHERE project_id = ?`,
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

      const newVersion = nextVersion(run.version);
      const now = isoNow();

      await tx.execute(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [FeatureExecutionState.SELECTED, newVersion, now, featureRunId, expectedVersion],
      );
      await tx.execute(
        `UPDATE workflow_states SET active_feature_run_id = ?, version = version + 1, updated_at = ? WHERE project_id = ?`,
        [featureRunId, now, projectId],
      );

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
        payload: { featureRunId, projectId, fromState: 'approved_pending_execution', toState: 'selected' },
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
