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

export const HumanUnblockFeaturePayloadSchema = z.object({
  featureRunId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  notes: z.string().min(1),
});
export type HumanUnblockFeaturePayload = z.infer<typeof HumanUnblockFeaturePayloadSchema>;

const validator = new StateTransitionValidator(FEATURE_EXECUTION_MATRIX, 'feature-execution');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
  feature_request_id: string;
}

/**
 * `blocked -> approved_pending_execution`, human-triggered (issue #53) — distinct from
 * `UnblockFeatureCommand`'s automatic, dependency-driven counterpart (they share the same matrix
 * row; see its comment for why). A feature blocked via `BlockFeatureCommand` is a purely human
 * decision unrelated to `feature_dependencies`, so this command lets a human directly confirm the
 * external precondition is now satisfied. Gives every `human_required` disposition a documented,
 * CLI-reachable "undo" (the asymmetry issue #53 was opened to close).
 *
 * **Dependency guard (post-merge review fix):** a feature run blocked via the issue #52
 * skip-cascade still carries a real `feature_dependencies` row pointing at a `feature_request`
 * whose only `feature_runs` row is now `skipped` — which can never reach `merged`. Unconditionally
 * transitioning back to `approved_pending_execution` (as this handler originally did) let an
 * operator see a successful unblock while `SelectFeatureHandler`'s own dependency guard (the real
 * dependency authority) would still reject the run forever, a misleading "recovered" state that
 * silently strands the feature again. Fixed by re-running the identical unmet-dependency query
 * `SelectFeatureHandler` uses before allowing the transition, rejecting with the same
 * `unmet-dependencies` `CommandError` type when any dependency has not reached `merged`. A human
 * wanting to force such a feature through anyway must first resolve the upstream dependency (e.g.
 * `minicoder plan import-backlog`/retry it to `merged`), not bypass the check here — there is no
 * separate dependency-waiver mechanism.
 */
export class HumanUnblockFeatureHandler implements CommandHandler<
  HumanUnblockFeaturePayload,
  FeatureExecutionState
> {
  readonly commandName = 'HumanUnblockFeatureCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'human-unblock-feature';

  async execute(
    envelope: CommandEnvelope<HumanUnblockFeaturePayload>,
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
        FeatureExecutionState.APPROVED_PENDING_EXECUTION,
      );

      // Mirrors SelectFeatureHandler's own dependency guard exactly — a dependency is met only
      // when a feature_run for it has reached 'merged'. Prevents unblocking a skip-cascade-blocked
      // run into a state that looks recovered but SelectFeatureHandler will still reject forever.
      const unmetDeps = await tx.query<{ id: string }>(
        `SELECT fd.id
         FROM feature_dependencies fd
         WHERE fd.source_fr_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM feature_runs fr
             WHERE fr.feature_request_id = fd.target_fr_id
               AND fr.current_execution_state = 'merged'
           )`,
        [run.feature_request_id],
      );
      if (unmetDeps.length > 0) {
        throw new CommandError({
          type: 'unmet-dependencies',
          title: 'Feature has unmet dependencies',
          status: 409,
          detail:
            `Cannot unblock feature: ${unmetDeps.length} dependency(ies) not yet merged. ` +
            `Resolve the upstream dependency (e.g. retry it to 'merged') before unblocking this run.`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE feature_runs SET current_execution_state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          FeatureExecutionState.APPROVED_PENDING_EXECUTION,
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
        eventType: 'feature.unblocked',
        fromState: FeatureExecutionState.BLOCKED,
        toState: FeatureExecutionState.APPROVED_PENDING_EXECUTION,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'feature.unblocked',
        payload: { featureRunId, projectId },
      });
      const result: CommandResult<FeatureExecutionState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: FeatureExecutionState.APPROVED_PENDING_EXECUTION,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
