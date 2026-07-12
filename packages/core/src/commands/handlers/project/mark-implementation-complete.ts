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
import { evaluateProjectAcceptance } from '../../../project/acceptance.js';

export const MarkImplementationCompletePayloadSchema = z.object({
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type MarkImplementationCompletePayload = z.infer<
  typeof MarkImplementationCompletePayloadSchema
>;

const validator = new StateTransitionValidator(PROJECT_LIFECYCLE_MATRIX, 'project-lifecycle');
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface ProjectRow {
  id: string;
  state: string;
  version: number;
}

/**
 * `active -> implementation_complete` (system actor, per the glossary's Project lifecycle
 * matrix). The guard is "all approved feature requests in merged state; Project Acceptance
 * Validation passes" — enforced here via `evaluateProjectAcceptance()`'s DB-knowable checks (see
 * that module's doc comment for why the CI-only checks — tests/build/lint/security-scan — are a
 * documented, not silently assumed, gap rather than something this handler can itself run).
 */
export class MarkImplementationCompleteHandler implements CommandHandler<
  MarkImplementationCompletePayload,
  ProjectState
> {
  readonly commandName = 'MarkImplementationCompleteCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'mark-implementation-complete';

  async execute(
    envelope: CommandEnvelope<MarkImplementationCompletePayload>,
    db: DbClient,
  ): Promise<CommandResult<ProjectState>> {
    const { projectId, expectedVersion } = envelope.payload;

    const acceptance = await evaluateProjectAcceptance(db, projectId);
    if (!acceptance.passed) {
      throw new CommandError({
        type: 'project-acceptance-failed',
        title: 'Project Acceptance Validation failed',
        status: 409,
        detail: `Project ${projectId} does not pass Project Acceptance Validation: ${acceptance.checks
          .filter((c) => !c.passed)
          .map((c) => c.name)
          .join(', ')}`,
      });
    }

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
      validator.assertValid(project.state as ProjectState, ProjectState.IMPLEMENTATION_COMPLETE);

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE projects SET state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          ProjectState.IMPLEMENTATION_COMPLETE,
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
        eventType: 'project.implementation_complete',
        fromState: ProjectState.ACTIVE,
        toState: ProjectState.IMPLEMENTATION_COMPLETE,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'project.implementation_complete',
        payload: { projectId },
      });

      const result: CommandResult<ProjectState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: ProjectState.IMPLEMENTATION_COMPLETE,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
