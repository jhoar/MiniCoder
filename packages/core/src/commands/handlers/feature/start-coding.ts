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
  assertLockFence,
} from '../../helpers.js';

export const StartCodingPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type StartCodingPayload = z.infer<typeof StartCodingPayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
}

export class StartCodingHandler implements CommandHandler<
  StartCodingPayload,
  FeatureExecutionState
> {
  readonly commandName = 'StartCodingCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'start-coding';

  async execute(
    envelope: CommandEnvelope<StartCodingPayload>,
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

      if (!envelope.lockContext) {
        throw new CommandError({
          type: 'missing-lock',
          title: 'Execution lock required',
          status: 400,
          detail: `${this.commandName} requires a workflow lock context`,
        });
      }
      await assertLockFence(tx, {
        ...envelope.lockContext,
        projectId,
        resourceKey: `execution-lane:${projectId}`,
      });

      // Transition guard: featureRunId must be the project's active feature run
      const wsRows = await tx.query<{ active_feature_run_id: string | null }>(
        `SELECT active_feature_run_id FROM workflow_states WHERE project_id = ?`,
        [projectId],
      );
      if (wsRows[0]?.active_feature_run_id !== featureRunId) {
        throw new CommandError({
          type: 'not-active-feature-run',
          title: 'Feature run is not the active run',
          status: 409,
          detail: `Feature run ${featureRunId} is not the active run for project ${projectId}`,
          instance: envelope.correlationId,
        });
      }

      const rows = await tx.query<FeatureRunRow>(
        `SELECT fr.id, fr.current_execution_state, fr.version
         FROM feature_runs fr
         JOIN feature_requests freq ON fr.feature_request_id = freq.id
         WHERE fr.id = ? AND freq.project_id = ?`,
        [featureRunId, projectId],
      );
      const run = rows[0];
      assertVersion('feature_runs', featureRunId, run, expectedVersion);
      validator.assertValid(
        run.current_execution_state as FeatureExecutionState,
        FeatureExecutionState.CODING,
      );
      const now = isoNow();
      // The UPDATE's WHERE clause re-checks workflow_states.automation_state atomically as part
      // of the same statement — not just the earlier active_feature_run_id pre-check above —
      // so a pause/budget-pause that commits between that pre-check and this UPDATE cannot let
      // coding start anyway (HIGH-1: automation control could otherwise be bypassed in the
      // window between feature selection and coding start).
      const startCodingAffected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?
           AND EXISTS (
             SELECT 1 FROM workflow_states
             WHERE project_id = ? AND automation_state = 'running'
           )`,
        [
          FeatureExecutionState.CODING,
          nextVersion(run.version),
          now,
          featureRunId,
          expectedVersion,
          projectId,
        ],
      );
      if (startCodingAffected === 0) {
        // Disambiguate why the atomic UPDATE matched no row: a stale version (0 rows) vs.
        // automation no longer running (0 rows for the same reason the SELECT above still saw
        // an active pointer) — mirrors SelectFeatureHandler's own two-step disambiguation.
        const wsRows = await tx.query<{ automation_state: string }>(
          `SELECT automation_state FROM workflow_states WHERE project_id = ?`,
          [projectId],
        );
        if (wsRows[0]?.automation_state !== 'running') {
          throw new CommandError({
            type: 'automation-paused',
            title: 'Automation is paused',
            status: 409,
            detail: `Cannot start coding: automation is ${wsRows[0]?.automation_state ?? 'unknown'}`,
            instance: envelope.correlationId,
          });
        }
        throw new OptimisticLockError('feature_runs', featureRunId, expectedVersion, -1);
      }
      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'feature.coding_started',
        fromState: FeatureExecutionState.SELECTED,
        toState: FeatureExecutionState.CODING,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.coding_started',
        payload: { featureRunId, projectId },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.CODING,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
