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
  insertHumanApproval,
} from '../../helpers.js';

export const RequestDesignDocumentRevisionPayloadSchema = z.object({
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  designDocumentId: z.string(),
  notes: z.string().optional(),
});
export type RequestDesignDocumentRevisionPayload = z.infer<
  typeof RequestDesignDocumentRevisionPayloadSchema
>;

const validator = new StateTransitionValidator(PROJECT_LIFECYCLE_MATRIX, 'project-lifecycle');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface ProjectRow {
  id: string;
  state: string;
  version: number;
}

/** `design_document_ready_for_review -> design_document_revision_requested` (approver actor). */
export class RequestDesignDocumentRevisionHandler implements CommandHandler<
  RequestDesignDocumentRevisionPayload,
  ProjectState
> {
  readonly commandName = 'RequestDesignDocumentRevisionCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'request-design-document-revision';

  async execute(
    envelope: CommandEnvelope<RequestDesignDocumentRevisionPayload>,
    db: DbClient,
  ): Promise<CommandResult<ProjectState>> {
    const { projectId, expectedVersion, designDocumentId, notes } = envelope.payload;

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
        ProjectState.DESIGN_DOCUMENT_REVISION_REQUESTED,
      );

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE projects SET state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          ProjectState.DESIGN_DOCUMENT_REVISION_REQUESTED,
          nextVersion(project.version),
          now,
          projectId,
          expectedVersion,
        ],
      );
      if (affected === 0) {
        throw new OptimisticLockError('projects', projectId, expectedVersion, -1);
      }

      await insertHumanApproval(tx, {
        projectId,
        contextType: 'design_document',
        contextId: designDocumentId,
        decision: 'rejected',
        actor: envelope.actor.id,
        actorRole: envelope.actor.role,
        notes,
      });

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'project.design_document_revision_requested',
        fromState: ProjectState.DESIGN_DOCUMENT_READY_FOR_REVIEW,
        toState: ProjectState.DESIGN_DOCUMENT_REVISION_REQUESTED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'project.design_document_revision_requested',
        payload: { projectId, designDocumentId },
      });

      const result: CommandResult<ProjectState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: ProjectState.DESIGN_DOCUMENT_REVISION_REQUESTED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
