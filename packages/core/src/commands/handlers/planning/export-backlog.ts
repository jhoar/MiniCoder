import { z } from 'zod';
import { ArtifactExportState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { ARTIFACT_EXPORT_MATRIX } from '../../../statemachine/machines/artifact-export.js';
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

export const ExportBacklogPayloadSchema = z.object({
  projectId: z.string(),
  planId: z.string(),
});
export type ExportBacklogPayload = z.infer<typeof ExportBacklogPayloadSchema>;

const validator = new StateTransitionValidator(ARTIFACT_EXPORT_MATRIX, 'artifact-export');
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface FeatureRow {
  fr_id: string;
  title: string;
  description: string;
  kind: string;
  priority: number;
}

/** Renders `backlog.md`-equivalent markdown from feature_requests, driving the same artifact-export matrix as ExportPlanCommand. */
export class ExportBacklogHandler implements CommandHandler<
  ExportBacklogPayload,
  ArtifactExportState
> {
  readonly commandName = 'ExportBacklogCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'export-backlog';

  async execute(
    envelope: CommandEnvelope<ExportBacklogPayload>,
    db: DbClient,
  ): Promise<CommandResult<ArtifactExportState>> {
    const { projectId, planId } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<ArtifactExportState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const features = await tx.query<FeatureRow>(
        `SELECT fr_id, title, description, kind, priority FROM feature_requests
         WHERE plan_id = ? AND project_id = ? ORDER BY priority ASC, fr_id ASC`,
        [planId, projectId],
      );
      if (features.length === 0) {
        throw new CommandError({
          type: 'not-found',
          title: 'No feature requests to export',
          status: 404,
          detail: `Plan ${planId} in project ${projectId} has no feature requests`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      const artifactExportId = generateId();
      await tx.execute(
        `INSERT INTO artifact_exports (id, project_id, artifact_type, state, content, format, version, created_at, updated_at)
         VALUES (?, ?, 'backlog', ?, NULL, 'markdown', 1, ?, ?)`,
        [artifactExportId, projectId, ArtifactExportState.PENDING, now, now],
      );

      validator.assertValid(ArtifactExportState.PENDING, ArtifactExportState.GENERATING);
      await tx.executeAffected(
        `UPDATE artifact_exports SET state = ?, version = 2, updated_at = ? WHERE id = ?`,
        [ArtifactExportState.GENERATING, now, artifactExportId],
      );

      const markdown = [
        '# Feature Backlog',
        '',
        ...features.flatMap((f) => [
          `## ${f.fr_id}: ${f.title}`,
          '',
          `Kind: ${f.kind}`,
          '',
          f.description,
          '',
        ]),
      ].join('\n');

      validator.assertValid(ArtifactExportState.GENERATING, ArtifactExportState.EXPORTED);
      const exportedAt = isoNow();
      await tx.executeAffected(
        `UPDATE artifact_exports SET state = ?, content = ?, exported_at = ?, version = 3, updated_at = ? WHERE id = ?`,
        [ArtifactExportState.EXPORTED, markdown, exportedAt, exportedAt, artifactExportId],
      );

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'artifact_export.exported',
        fromState: ArtifactExportState.PENDING,
        toState: ArtifactExportState.EXPORTED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'artifact_export.exported',
        payload: { projectId, planId, artifactExportId, featureCount: features.length },
      });

      const result: CommandResult<ArtifactExportState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: ArtifactExportState.EXPORTED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
