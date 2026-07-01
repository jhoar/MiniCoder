import { z } from 'zod';
import { UserRole } from '../../../domain/states.js';
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

export const IngestSpecificationPayloadSchema = z.object({
  projectId: z.string(),
  content: z.string(),
  contentType: z.string().default('text/plain'),
});
export type IngestSpecificationPayload = z.infer<typeof IngestSpecificationPayloadSchema>;

export type IngestSpecificationResultState = 'ingested';

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Insert-only: records a specification_inputs row. No state matrix — a specification has no lifecycle of its own. */
export class IngestSpecificationHandler
  implements CommandHandler<IngestSpecificationPayload, IngestSpecificationResultState>
{
  readonly commandName = 'IngestSpecificationCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'ingest-specification';

  async execute(
    envelope: CommandEnvelope<IngestSpecificationPayload>,
    db: DbClient,
  ): Promise<CommandResult<IngestSpecificationResultState>> {
    const { projectId, content, contentType } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<IngestSpecificationResultState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const now = isoNow();
      const specificationInputId = generateId();
      await tx.execute(
        `INSERT INTO specification_inputs (id, project_id, content, content_type, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [specificationInputId, projectId, content, contentType, now, now],
      );

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'specification.ingested',
        fromState: 'none',
        toState: 'ingested',
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'specification.ingested',
        payload: { projectId, specificationInputId },
      });

      const result: CommandResult<IngestSpecificationResultState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: 'ingested',
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
