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
import {
  DESIGN_DOCUMENT_SECTION_NAMES,
  isPlaceholderSectionContent,
} from '../../../design-doc/generator.js';

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
  design_document_id: string | null;
}

interface DesignDocumentRow {
  id: string;
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
        `SELECT id, state, design_document_id FROM artifact_exports WHERE id = ? AND project_id = ? AND artifact_type = 'design_document'`,
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
      // Durable artifact-to-document association (migration 0014, PR review finding): without
      // this, the ownership/completeness checks below only prove the CALLER-SUPPLIED
      // designDocumentId is valid and complete — they cannot prove it's the SAME document this
      // artifact_exports row was actually generated from. A manual/system replay could otherwise
      // pair an already-exported artifact with a different, also-complete design_documents row in
      // the same project and receive success. `design_document_id` is set once, at INSERT time,
      // by `GenerateDesignDocumentHandler`/`RegenerateDesignDocumentHandler` — the same call that
      // creates both rows together — so it is never ambiguous which document an artifact belongs
      // to. Fails closed (round 2 PR review fix): a NULL `design_document_id` is REJECTED, not
      // treated as "no binding to check" — every `artifact_type = 'design_document'` row this
      // codebase's own handlers write always sets it, so a NULL here only ever means a
      // pre-migration/manually-inserted row this handler cannot prove is bound to anything; a
      // caller wanting to export/ready such a row must first backfill its `design_document_id`
      // directly.
      if (artifact.design_document_id !== designDocumentId) {
        throw new CommandError({
          type: 'design-document-mismatch',
          title: 'Design document does not match the artifact export',
          status: 409,
          detail: `artifact_exports ${artifactExportId} is bound to design_documents ${artifact.design_document_id ?? 'NULL'}, not ${designDocumentId}`,
        });
      }
      // Document ownership and section-completeness are validated BEFORE the already-exported
      // idempotent-return and failed-state-rejection branches below — not after, as an earlier
      // revision of this handler did. Validating only on the "not yet exported" path let a
      // manual/system replay (this handler is on the generic-dispatch system-replay allow-list)
      // pass an already-exported artifact from the same project together with a different or
      // incomplete `designDocumentId` and receive a clean idempotent success with no ownership/
      // completeness check ever running — a real data-integrity gap found in PR review, since
      // `RecordDesignDocumentReadyCommand` trusts this handler's success to mean the referenced
      // document was actually the one rendered into the artifact.
      const docRows = await tx.query<DesignDocumentRow>(
        `SELECT id FROM design_documents WHERE id = ? AND project_id = ?`,
        [designDocumentId, projectId],
      );
      if (!docRows[0]) {
        throw new CommandError({
          type: 'not-found',
          title: 'Design document not found',
          status: 404,
          detail: `design_documents ${designDocumentId} not found for project ${projectId}`,
        });
      }

      const sectionRows = await tx.query<{
        section_name: string;
        content: string;
        order_index: number;
      }>(
        `SELECT section_name, content, order_index FROM design_document_sections WHERE design_document_id = ? ORDER BY order_index ASC`,
        [designDocumentId],
      );
      const sectionNamesPresent = new Set(sectionRows.map((s) => s.section_name));
      const missingOrBlank = DESIGN_DOCUMENT_SECTION_NAMES.filter((name) => {
        const row = sectionRows.find((s) => s.section_name === name);
        return (
          !sectionNamesPresent.has(name) ||
          !row?.content ||
          row.content.trim().length === 0 ||
          isPlaceholderSectionContent(row.content)
        );
      });
      if (missingOrBlank.length > 0) {
        throw new CommandError({
          type: 'incomplete-sections',
          title: 'Design document sections are incomplete',
          status: 409,
          detail: `design_documents ${designDocumentId} is missing, blank, or still placeholder content for: ${missingOrBlank.join(', ')}`,
        });
      }

      if (artifact.state === ArtifactExportState.EXPORTED) {
        // Idempotent re-export: already exported, ownership/completeness re-validated above, no
        // mutation, no error — matches this handler's own idempotency-key claim/fulfill pattern
        // for a replayed dispatch.
        const result: CommandResult<ArtifactExportState> = {
          commandId: envelope.commandId,
          accepted: true,
          resultingState: ArtifactExportState.EXPORTED,
          emittedEventIds: [],
        };
        await fulfillIdempotencyKey(tx, claim.claimId, result);
        return result;
      }
      if (artifact.state === ArtifactExportState.FAILED) {
        throw new CommandError({
          type: 'artifact-export-failed',
          title: 'Design document artifact export previously failed',
          status: 409,
          detail: `artifact_exports ${artifactExportId} is in 'failed' state and cannot be re-exported by this command`,
        });
      }

      const projectRows = await tx.query<{ name: string }>(
        `SELECT name FROM projects WHERE id = ?`,
        [projectId],
      );
      const projectName = projectRows[0]?.name ?? projectId;

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
      const exportAffected = await tx.executeAffected(
        `UPDATE artifact_exports SET state = ?, content = ?, exported_at = ?, updated_at = ?
         WHERE id = ? AND state = ?`,
        [
          ArtifactExportState.EXPORTED,
          markdown,
          exportedAt,
          exportedAt,
          artifactExportId,
          ArtifactExportState.GENERATING,
        ],
      );
      if (exportAffected === 0) {
        throw new CommandError({
          type: 'artifact-export-not-generating',
          title: 'Design document artifact export is no longer in the generating state',
          status: 409,
          detail: `artifact_exports ${artifactExportId} was not in 'generating' state at update time`,
        });
      }

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
