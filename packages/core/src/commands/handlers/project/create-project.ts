import { z } from 'zod';
import { UserRole } from '../../../domain/states.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import { CommandError } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import {
  isoNow,
  writeWorkflowEvent,
  claimIdempotencyKey,
  fulfillIdempotencyKey,
} from '../../helpers.js';

export const CreateProjectPayloadSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
});
export type CreateProjectPayload = z.infer<typeof CreateProjectPayloadSchema>;

export type CreateProjectResultState = 'active';

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Insert-only: records a `projects` row. Genesis is an INSERT, not a matrix transition — the
 * same posture `clarification_sessions`/`implementation_plans` already establish for their own
 * genesis rows (CLAUDE.md's Bootstrap Planner Operational Constraints). `projects.id` is a plain
 * `TEXT PRIMARY KEY` a caller chooses directly (e.g. a human-readable slug like `ons`), not a
 * `generateId()`-minted opaque ID — every downstream table (`specification_inputs`,
 * `implementation_plans`, `feature_requests`, etc.) carries a `project_id` foreign key that
 * requires this row to exist first, so without this handler nothing project-scoped can ever be
 * created at all.
 */
export class CreateProjectHandler
  implements CommandHandler<CreateProjectPayload, CreateProjectResultState>
{
  readonly commandName = 'CreateProjectCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'create-project';

  async execute(
    envelope: CommandEnvelope<CreateProjectPayload>,
    db: DbClient,
  ): Promise<CommandResult<CreateProjectResultState>> {
    const { id, name, description } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<CreateProjectResultState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const existing = await tx.query<{ id: string }>('SELECT id FROM projects WHERE id = ?', [
        id,
      ]);
      if (existing.length > 0) {
        throw new CommandError({
          type: 'project-already-exists',
          title: 'Project already exists',
          status: 409,
          detail: `A project with id '${id}' already exists.`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      await tx.execute(
        `INSERT INTO projects (id, name, description, state, version, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 1, ?, ?)`,
        [id, name, description ?? null, now, now],
      );

      const eventId = await writeWorkflowEvent(tx, {
        projectId: id,
        eventType: 'project.created',
        fromState: 'none',
        toState: 'active',
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });

      const result: CommandResult<CreateProjectResultState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: 'active',
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
