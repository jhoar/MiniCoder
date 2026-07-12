import { z } from 'zod';
import { ArtifactExportState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { ARTIFACT_EXPORT_MATRIX } from '../../../statemachine/machines/artifact-export.js';
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
import { renderDesignDocumentMarkdown } from '../../../design-doc/render-markdown.js';

export const ExportDesignDocumentPayloadSchema = z.object({
  projectId: z.string(),
  designDocumentId: z.string(),
  artifactExportId: z.string(),
});
export type ExportDesignDocumentPayload = z.infer<typeof ExportDesignDocumentPayloadSchema>;

const validator = new StateTransitionValidator(ARTIFACT_EXPORT_MATRIX, 'artifact-export');
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface ArtifactExportRow {
  id: string;
  state: string;
}

/**
 * Renders `final-design-document.md` from `design_document_sections`/`design_decisions`/
 * `glossary_terms` and drives the pre-existing `artifact_exports` row (created by
 * `GenerateDesignDocumentHandler`/`RegenerateDesignDocumentHandler` at `pending`) through
 * `pending -> generating -> exported`, matching `ExportBacklogHandler`'s exact two-step
 * `assertValid` shape — the difference here is the `artifact_exports` row already exists (this
 * handler doesn't create it), since `create_artifact_export_record` is that other handler's own
 * matrix side effect, not this one's. `RecordDesignDocumentReadyCommand`'s "artifact exported"
 * guard requires this handler to have already run and left the row at `exported`.
 */
export class ExportDesignDocumentHandler implements CommandHandler<
  ExportDesignDocumentPayload,
  ArtifactExportState
> {
  readonly commandName = 'ExportDesignDocumentCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'export-design-document';

  async execute(
    envelope: CommandEnvelope<ExportDesignDocumentPayload>,
    db: DbClient,
  ): Promise<CommandResult<ArtifactExportState>> {
    const { projectId, designDocumentId, artifactExportId } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<ArtifactExportState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const artifactRows = await tx.query<ArtifactExportRow>(
        `SELECT id, state FROM artifact_exports WHERE id = ? AND project_id = ? AND artifact_type = 'design_document'`,
        [artifactExportId, projectId],
      );
      const artifact = artifactRows[0];
      if (!artifact) {
        throw new CommandError({
          type: 'not-found',
          title: 'Design document artifact export not found',
          status: 404,
          detail: `artifact_exports ${artifactExportId} not found for project ${projectId}`,
        });
      }

      const projectRows = await tx.query<{ name: string }>(
        `SELECT name FROM projects WHERE id = ?`,
        [projectId],
      );
      const projectName = projectRows[0]?.name ?? projectId;

      const sectionRows = await tx.query<{
        section_name: string;
        content: string;
        order_index: number;
      }>(
        `SELECT section_name, content, order_index FROM design_document_sections WHERE design_document_id = ? ORDER BY order_index ASC`,
        [designDocumentId],
      );
      if (sectionRows.length === 0) {
        throw new CommandError({
          type: 'no-sections',
          title: 'No design document sections to export',
          status: 409,
          detail: `design_documents ${designDocumentId} has no sections generated yet`,
        });
      }

      const decisionRows = await tx.query<{
        title: string;
        context: string | null;
        decision: string;
        consequences: string | null;
        status: string;
      }>(
        `SELECT title, context, decision, consequences, status FROM design_decisions WHERE project_id = ? ORDER BY created_at ASC`,
        [projectId],
      );
      const glossaryRows = await tx.query<{
        term: string;
        definition: string;
        category: string | null;
      }>(
        `SELECT term, definition, category FROM glossary_terms WHERE project_id = ? OR project_id IS NULL ORDER BY term ASC`,
        [projectId],
      );

      const now = isoNow();

      if (artifact.state === ArtifactExportState.PENDING) {
        validator.assertValid(ArtifactExportState.PENDING, ArtifactExportState.GENERATING);
        await tx.executeAffected(
          `UPDATE artifact_exports SET state = ?, updated_at = ? WHERE id = ?`,
          [ArtifactExportState.GENERATING, now, artifactExportId],
        );
      }

      const markdown = renderDesignDocumentMarkdown({
        projectName,
        sections: sectionRows.map((s) => ({
          sectionName: s.section_name,
          content: s.content,
          orderIndex: s.order_index,
        })),
        designDecisions: decisionRows,
        glossaryTerms: glossaryRows,
      });

      validator.assertValid(ArtifactExportState.GENERATING, ArtifactExportState.EXPORTED);
      const exportedAt = isoNow();
      await tx.executeAffected(
        `UPDATE artifact_exports SET state = ?, content = ?, exported_at = ?, updated_at = ? WHERE id = ?`,
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
        payload: { projectId, designDocumentId, artifactExportId, artifactType: 'design_document' },
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
