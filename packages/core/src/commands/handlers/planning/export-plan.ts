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

export const ExportPlanPayloadSchema = z.object({
  projectId: z.string(),
  planId: z.string(),
});
export type ExportPlanPayload = z.infer<typeof ExportPlanPayloadSchema>;

const validator = new StateTransitionValidator(ARTIFACT_EXPORT_MATRIX, 'artifact-export');
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface PlanRow {
  title: string;
  summary: string | null;
}

interface SectionRow {
  title: string;
  content: string;
}

/**
 * Drives artifact-export's pending -> generating -> exported matrix in a single synchronous call,
 * rendering `plan.md`-equivalent markdown into artifact_exports.content. This is a generated
 * snapshot only — no runtime logic reads it back (docs architectural decision #8).
 */
export class ExportPlanHandler implements CommandHandler<ExportPlanPayload, ArtifactExportState> {
  readonly commandName = 'ExportPlanCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'export-plan';

  async execute(
    envelope: CommandEnvelope<ExportPlanPayload>,
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

      const planRows = await tx.query<PlanRow>(
        `SELECT title, summary FROM implementation_plans WHERE id = ? AND project_id = ?`,
        [planId, projectId],
      );
      const plan = planRows[0];
      if (!plan) {
        throw new CommandError({
          type: 'not-found',
          title: 'Plan not found',
          status: 404,
          detail: `Plan ${planId} not found in project ${projectId}`,
          instance: envelope.correlationId,
        });
      }
      const sections = await tx.query<SectionRow>(
        `SELECT title, content FROM plan_sections WHERE plan_id = ? ORDER BY order_index ASC`,
        [planId],
      );

      const now = isoNow();
      const artifactExportId = generateId();
      await tx.execute(
        `INSERT INTO artifact_exports (id, project_id, artifact_type, state, content, format, version, created_at, updated_at)
         VALUES (?, ?, 'plan', ?, NULL, 'markdown', 1, ?, ?)`,
        [artifactExportId, projectId, ArtifactExportState.PENDING, now, now],
      );

      validator.assertValid(ArtifactExportState.PENDING, ArtifactExportState.GENERATING);
      await tx.executeAffected(
        `UPDATE artifact_exports SET state = ?, version = 2, updated_at = ? WHERE id = ?`,
        [ArtifactExportState.GENERATING, now, artifactExportId],
      );

      const markdown = [
        `# ${plan.title}`,
        '',
        plan.summary ?? '',
        '',
        ...sections.flatMap((section) => [`## ${section.title}`, '', section.content, '']),
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
        payload: { projectId, planId, artifactExportId },
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
