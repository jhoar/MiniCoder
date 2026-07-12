import { z } from 'zod';
import { ProjectState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { PROJECT_LIFECYCLE_MATRIX } from '../../../statemachine/machines/project-lifecycle.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import { OptimisticLockError } from '../../../persistence/types.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import { CommandError } from '../../types.js';
import {
  isoNow,
  generateId,
  writeWorkflowEvent,
  writeOutboxEvent,
  claimIdempotencyKey,
  fulfillIdempotencyKey,
} from '../../helpers.js';

export const GenerateDesignDocumentPayloadSchema = z.object({
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type GenerateDesignDocumentPayload = z.infer<typeof GenerateDesignDocumentPayloadSchema>;

const validator = new StateTransitionValidator(PROJECT_LIFECYCLE_MATRIX, 'project-lifecycle');
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface ProjectRow {
  id: string;
  state: string;
  version: number;
}

/**
 * `implementation_complete -> design_document_generating` (operator actor). Creates the fresh
 * `design_documents` row (state='draft') this generation cycle writes sections against, and the
 * paired `artifact_exports` row (`artifact_type='design_document'`) the matrix's
 * `create_artifact_export_record` side effect calls for — mirroring `ExportBacklogHandler`'s own
 * "insert the artifact_exports row, then progress its state as work happens" shape. The actual
 * generation (calling `DocumentationAgentAdapter`, writing `design_document_sections`) happens in
 * the separate `run-design-doc` Trigger.dev task (CLAUDE.md's "never inline" rule) — this handler
 * only performs the state transition and creates the rows the task will fill in.
 */
export class GenerateDesignDocumentHandler implements CommandHandler<
  GenerateDesignDocumentPayload,
  ProjectState
> {
  readonly commandName = 'GenerateDesignDocumentCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'generate-design-document';

  async execute(
    envelope: CommandEnvelope<GenerateDesignDocumentPayload>,
    db: DbClient,
  ): Promise<CommandResult<ProjectState>> {
    const { projectId, expectedVersion } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<ProjectState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const rows = await tx.query<ProjectRow>(
        `SELECT id, state, version FROM projects WHERE id = ?`,
        [projectId],
      );
      const project = rows[0];
      if (!project) {
        throw new CommandError({
          type: 'not-found',
          title: 'Project not found',
          status: 404,
          detail: `Project ${projectId} not found`,
        });
      }
      assertVersion('projects', projectId, project, expectedVersion);
      validator.assertValid(project.state as ProjectState, ProjectState.DESIGN_DOCUMENT_GENERATING);

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE projects SET state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          ProjectState.DESIGN_DOCUMENT_GENERATING,
          nextVersion(project.version),
          now,
          projectId,
          expectedVersion,
        ],
      );
      if (affected === 0) {
        throw new OptimisticLockError('projects', projectId, expectedVersion, -1);
      }

      const designDocumentId = generateId();
      await tx.execute(
        `INSERT INTO design_documents (id, project_id, state, version, created_at, updated_at)
         VALUES (?, ?, 'draft', 1, ?, ?)`,
        [designDocumentId, projectId, now, now],
      );

      const artifactExportId = generateId();
      await tx.execute(
        `INSERT INTO artifact_exports (id, project_id, artifact_type, state, content, format, version, created_at, updated_at)
         VALUES (?, ?, 'design_document', 'pending', NULL, 'markdown', 1, ?, ?)`,
        [artifactExportId, projectId, now, now],
      );

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'project.design_document_generating',
        fromState: ProjectState.IMPLEMENTATION_COMPLETE,
        toState: ProjectState.DESIGN_DOCUMENT_GENERATING,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'project.design_document_generating',
        payload: { projectId, designDocumentId, artifactExportId },
      });

      const result: CommandResult<ProjectState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: ProjectState.DESIGN_DOCUMENT_GENERATING,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
