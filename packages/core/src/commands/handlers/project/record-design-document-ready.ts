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
  writeWorkflowEvent,
  writeOutboxEvent,
  claimIdempotencyKey,
  fulfillIdempotencyKey,
} from '../../helpers.js';

export const RecordDesignDocumentReadyPayloadSchema = z.object({
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  designDocumentId: z.string(),
  artifactExportId: z.string(),
});
export type RecordDesignDocumentReadyPayload = z.infer<
  typeof RecordDesignDocumentReadyPayloadSchema
>;

const validator = new StateTransitionValidator(PROJECT_LIFECYCLE_MATRIX, 'project-lifecycle');
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface ProjectRow {
  id: string;
  state: string;
  version: number;
}

interface ArtifactExportRow {
  id: string;
  state: string;
}

/**
 * `design_document_generating -> design_document_ready_for_review` (system actor). Called by the
 * `run-design-doc` Trigger.dev task after `DocumentationAgentAdapter` has produced all 13 sections
 * (written to `design_document_sections` by the generator, not this handler — this handler is
 * pure state-transition logic, mirroring `RecordCodePushedHandler`'s separation from
 * `CodexCoderAdapter`) and the `final-design-document.md` artifact export has completed. The guard
 * ("artifact exported") is enforced by requiring the referenced `artifact_exports` row to already
 * be at `exported` — a caller that dispatches this before the export finished gets a clear
 * `artifact-not-exported` error rather than silently marking the document ready.
 */
export class RecordDesignDocumentReadyHandler implements CommandHandler<
  RecordDesignDocumentReadyPayload,
  ProjectState
> {
  readonly commandName = 'RecordDesignDocumentReadyCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'record-design-document-ready';

  async execute(
    envelope: CommandEnvelope<RecordDesignDocumentReadyPayload>,
    db: DbClient,
  ): Promise<CommandResult<ProjectState>> {
    const { projectId, expectedVersion, designDocumentId, artifactExportId } = envelope.payload;

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
      validator.assertValid(
        project.state as ProjectState,
        ProjectState.DESIGN_DOCUMENT_READY_FOR_REVIEW,
      );

      const artifactRows = await tx.query<ArtifactExportRow>(
        `SELECT id, state FROM artifact_exports WHERE id = ? AND project_id = ?`,
        [artifactExportId, projectId],
      );
      const artifact = artifactRows[0];
      if (!artifact || artifact.state !== 'exported') {
        throw new CommandError({
          type: 'artifact-not-exported',
          title: 'Design document artifact not yet exported',
          status: 409,
          detail: `artifact_exports ${artifactExportId} is not in 'exported' state`,
        });
      }

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE projects SET state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          ProjectState.DESIGN_DOCUMENT_READY_FOR_REVIEW,
          nextVersion(project.version),
          now,
          projectId,
          expectedVersion,
        ],
      );
      if (affected === 0) {
        throw new OptimisticLockError('projects', projectId, expectedVersion, -1);
      }

      await tx.executeAffected(
        `UPDATE design_documents SET state = 'ready_for_review', version = version + 1, updated_at = ? WHERE id = ? AND project_id = ?`,
        [now, designDocumentId, projectId],
      );

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'project.design_document_ready',
        fromState: ProjectState.DESIGN_DOCUMENT_GENERATING,
        toState: ProjectState.DESIGN_DOCUMENT_READY_FOR_REVIEW,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'project.design_document_ready',
        payload: { projectId, designDocumentId, artifactExportId },
      });

      const result: CommandResult<ProjectState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: ProjectState.DESIGN_DOCUMENT_READY_FOR_REVIEW,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
