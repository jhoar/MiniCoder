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

export const CompleteProjectPayloadSchema = z.object({
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type CompleteProjectPayload = z.infer<typeof CompleteProjectPayloadSchema>;

const validator = new StateTransitionValidator(PROJECT_LIFECYCLE_MATRIX, 'project-lifecycle');
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface ProjectRow {
  id: string;
  state: string;
  version: number;
}

/** `design_document_approved -> project_complete` (system actor) — the terminal transition. */
export class CompleteProjectHandler implements CommandHandler<
  CompleteProjectPayload,
  ProjectState
> {
  readonly commandName = 'CompleteProjectCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'complete-project';

  async execute(
    envelope: CommandEnvelope<CompleteProjectPayload>,
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
      validator.assertValid(project.state as ProjectState, ProjectState.PROJECT_COMPLETE);

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE projects SET state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          ProjectState.PROJECT_COMPLETE,
          nextVersion(project.version),
          now,
          projectId,
          expectedVersion,
        ],
      );
      if (affected === 0) {
        throw new OptimisticLockError('projects', projectId, expectedVersion, -1);
      }

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'project.complete',
        fromState: ProjectState.DESIGN_DOCUMENT_APPROVED,
        toState: ProjectState.PROJECT_COMPLETE,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, { eventType: 'project.complete', payload: { projectId } });

      const result: CommandResult<ProjectState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: ProjectState.PROJECT_COMPLETE,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
