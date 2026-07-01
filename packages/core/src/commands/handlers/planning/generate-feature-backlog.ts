import { z } from 'zod';
import { FeatureExecutionState, FeatureKind, UserRole } from '../../../domain/states.js';
import { CommandError } from '../../types.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import {
  isoNow,
  generateId,
  writeWorkflowEvent,
  writeOutboxEvent,
  claimIdempotencyKey,
  fulfillIdempotencyKey,
} from '../../helpers.js';

const FeatureInputSchema = z.object({
  frId: z.string().regex(/^FR-\d+$/),
  title: z.string(),
  description: z.string(),
  kind: z.enum([FeatureKind.FEATURE, FeatureKind.DISCOVERY]).default(FeatureKind.FEATURE),
  priority: z.number().int().default(0),
  dependsOnFrIds: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  testExpectations: z
    .array(z.object({ description: z.string(), testType: z.enum(['unit', 'integration', 'system']).nullable() }))
    .default([]),
});

export const GenerateFeatureBacklogPayloadSchema = z.object({
  projectId: z.string(),
  planId: z.string(),
  features: z.array(FeatureInputSchema).min(1),
});
export type GenerateFeatureBacklogPayload = z.infer<typeof GenerateFeatureBacklogPayloadSchema>;

export type GenerateFeatureBacklogResultState = 'generated';

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Writes feature_requests, feature_dependencies, acceptance_criteria, and test_expectations for a
 * plan (docs/02 §5, §9). `kind='discovery'` rows are inserted with `executable=false` and are
 * excluded from activation by ActivatePlanCommand — they are never part of the executable
 * backlog. `feature_requests.state` is a static label (see ActivatePlanCommand) — the real
 * execution readiness gate is the `feature_runs` rows ActivatePlanCommand creates.
 */
export class GenerateFeatureBacklogHandler
  implements CommandHandler<GenerateFeatureBacklogPayload, GenerateFeatureBacklogResultState>
{
  readonly commandName = 'GenerateFeatureBacklogCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'generate-feature-backlog';

  async execute(
    envelope: CommandEnvelope<GenerateFeatureBacklogPayload>,
    db: DbClient,
  ): Promise<CommandResult<GenerateFeatureBacklogResultState>> {
    const { projectId, planId, features } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<GenerateFeatureBacklogResultState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const planRows = await tx.query<{ id: string }>(
        `SELECT id FROM implementation_plans WHERE id = ? AND project_id = ?`,
        [planId, projectId],
      );
      if (!planRows[0]) {
        throw new CommandError({
          type: 'not-found',
          title: 'Implementation plan not found',
          status: 404,
          detail: `Plan ${planId} not found in project ${projectId}`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      const idByFrId = new Map<string, string>();

      for (const feature of features) {
        const id = generateId();
        idByFrId.set(feature.frId, id);
        await tx.execute(
          `INSERT INTO feature_requests
             (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            id,
            planId,
            projectId,
            feature.frId,
            feature.title,
            feature.description,
            feature.kind,
            feature.kind === FeatureKind.FEATURE ? 1 : 0,
            FeatureExecutionState.APPROVED_PENDING_EXECUTION,
            feature.priority,
            now,
            now,
          ],
        );

        for (let i = 0; i < feature.acceptanceCriteria.length; i++) {
          await tx.execute(
            `INSERT INTO acceptance_criteria (id, feature_request_id, description, order_index, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
            [generateId(), id, feature.acceptanceCriteria[i], i, now, now],
          );
        }
        for (let i = 0; i < feature.testExpectations.length; i++) {
          const te = feature.testExpectations[i]!;
          await tx.execute(
            `INSERT INTO test_expectations (id, feature_request_id, description, test_type, order_index, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
            [generateId(), id, te.description, te.testType, i, now, now],
          );
        }
      }

      for (const feature of features) {
        const sourceId = idByFrId.get(feature.frId)!;
        for (const targetFrId of feature.dependsOnFrIds) {
          const targetId = idByFrId.get(targetFrId);
          if (!targetId) {
            throw new CommandError({
              type: 'unknown-dependency',
              title: 'Unknown feature dependency',
              status: 400,
              detail: `Feature ${feature.frId} depends on unknown fr_id "${targetFrId}"`,
              instance: envelope.correlationId,
            });
          }
          await tx.execute(
            `INSERT INTO feature_dependencies (id, source_fr_id, target_fr_id, created_at) VALUES (?, ?, ?, ?)`,
            [generateId(), sourceId, targetId, now],
          );
        }
      }

      // A backlog change invalidates any prior ValidateBacklogCommand result — bump backlog_version
      // and clear the validated_* columns so SubmitPlanForApprovalCommand's gate re-requires
      // validation against the new backlog.
      await tx.execute(
        `UPDATE implementation_plans
         SET backlog_version = backlog_version + 1, backlog_validated_at = NULL,
             backlog_validated_state = NULL, backlog_validated_version = NULL, updated_at = ?
         WHERE id = ?`,
        [now, planId],
      );

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'backlog.generated',
        fromState: 'none',
        toState: 'generated',
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'backlog.generated',
        payload: { projectId, planId, featureCount: features.length },
      });

      const result: CommandResult<GenerateFeatureBacklogResultState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: 'generated',
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
