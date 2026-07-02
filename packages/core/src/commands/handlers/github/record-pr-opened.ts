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
  generateId,
} from '../../helpers.js';
import { insertPullRequestRow } from './pull-request-row.js';

export const RecordPrOpenedPayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  prNumber: z.number().int().positive(),
  branchName: z.string().min(1),
  baseBranch: z.string().min(1),
  headSha: z.string().nullable().optional(),
});
export type RecordPrOpenedPayload = z.infer<typeof RecordPrOpenedPayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
}

export class RecordPrOpenedHandler implements CommandHandler<
  RecordPrOpenedPayload,
  FeatureExecutionState
> {
  readonly commandName = 'RecordPrOpenedCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'record-pr-opened';

  async execute(
    envelope: CommandEnvelope<RecordPrOpenedPayload>,
    db: DbClient,
  ): Promise<CommandResult<FeatureExecutionState>> {
    const { featureRunId, projectId, expectedVersion, prNumber, branchName, baseBranch, headSha } =
      envelope.payload;
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

      const rows = await tx.query<FeatureRunRow>(
        `SELECT fr.id, fr.current_execution_state, fr.version
         FROM feature_runs fr
         JOIN feature_requests freq ON fr.feature_request_id = freq.id
         WHERE fr.id = ? AND freq.project_id = ?`,
        [featureRunId, projectId],
      );
      const run = rows[0];
      assertVersion('feature_runs', featureRunId, run, expectedVersion);
      const fromState = run.current_execution_state as FeatureExecutionState;
      validator.assertValid(fromState, FeatureExecutionState.PR_OPENED);
      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.PR_OPENED,
          nextVersion(run.version),
          now,
          featureRunId,
          expectedVersion,
        ],
      );
      if (affected === 0) {
        throw new OptimisticLockError('feature_runs', featureRunId, expectedVersion, -1);
      }
      await insertPullRequestRow(tx, {
        id: generateId(),
        featureRunId,
        prNumber,
        branchName,
        baseBranch,
        headSha: headSha ?? null,
      });
      const eventId = await writeWorkflowEvent(tx, {
        featureRunId,
        projectId,
        eventType: 'github.pr_opened',
        fromState,
        toState: FeatureExecutionState.PR_OPENED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.pr_opened',
        payload: { featureRunId, projectId, prNumber, branchName, baseBranch },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.PR_OPENED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
