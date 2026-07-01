import { z } from 'zod';
import { ClarificationStatus, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { CLARIFICATION_MATRIX } from '../../../statemachine/machines/clarification.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import { OptimisticLockError } from '../../../persistence/types.js';
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

export const RequestAnotherClarificationRoundPayloadSchema = z.object({
  clarificationSessionId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type RequestAnotherClarificationRoundPayload = z.infer<
  typeof RequestAnotherClarificationRoundPayloadSchema
>;

const validator = new StateTransitionValidator(CLARIFICATION_MATRIX, 'clarification');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionRow {
  id: string;
  status: string;
  round: number;
  max_rounds: number;
  version: number;
}

/**
 * clarification_in_progress -> clarification_required, taken when the re-assessed spec is still
 * insufficient but the round budget is not yet exhausted. Round counting happens in
 * StartClarificationCommand (the point a new round of questions is actually asked); this
 * transition only re-opens the session for the next StartClarificationCommand call.
 */
export class RequestAnotherClarificationRoundHandler
  implements CommandHandler<RequestAnotherClarificationRoundPayload, ClarificationStatus>
{
  readonly commandName = 'RequestAnotherClarificationRoundCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'request-another-clarification-round';

  async execute(
    envelope: CommandEnvelope<RequestAnotherClarificationRoundPayload>,
    db: DbClient,
  ): Promise<CommandResult<ClarificationStatus>> {
    const { clarificationSessionId, projectId, expectedVersion } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<ClarificationStatus>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const rows = await tx.query<SessionRow>(
        `SELECT id, status, round, max_rounds, version FROM clarification_sessions WHERE id = ? AND project_id = ?`,
        [clarificationSessionId, projectId],
      );
      const session = rows[0];
      if (!session) {
        throw new CommandError({
          type: 'not-found',
          title: 'Clarification session not found',
          status: 404,
          detail: `Clarification session ${clarificationSessionId} not found in project ${projectId}`,
          instance: envelope.correlationId,
        });
      }
      assertVersion('clarification_sessions', clarificationSessionId, session, expectedVersion);
      validator.assertValid(session.status as ClarificationStatus, ClarificationStatus.REQUIRED);

      if (session.round >= session.max_rounds) {
        throw new CommandError({
          type: 'clarification-round-limit',
          title: 'Clarification round limit reached',
          status: 409,
          detail: `Session ${clarificationSessionId} has already used ${session.round}/${session.max_rounds} rounds`,
          instance: envelope.correlationId,
        });
      }

      // Mirrors CompleteClarificationHandler's guard: a round cannot be reopened while the
      // current round still has unanswered questions — the caller must obtain answers (or let
      // BlockClarificationCommand trip the circuit breaker) before advancing.
      const unanswered = await tx.query<{ id: string }>(
        `SELECT cq.id FROM clarification_questions cq
         WHERE cq.clarification_session_id = ? AND cq.round = ?
           AND NOT EXISTS (SELECT 1 FROM clarification_answers ca WHERE ca.clarification_question_id = cq.id)`,
        [clarificationSessionId, session.round],
      );
      if (unanswered.length > 0) {
        throw new CommandError({
          type: 'unanswered-questions',
          title: 'Clarification round has unanswered questions',
          status: 409,
          detail: `${unanswered.length} question(s) in round ${session.round} still unanswered`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE clarification_sessions SET status = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [ClarificationStatus.REQUIRED, nextVersion(session.version), now, clarificationSessionId, expectedVersion],
      );
      if (affected === 0) {
        throw new OptimisticLockError('clarification_sessions', clarificationSessionId, expectedVersion, -1);
      }

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'clarification.round_completed',
        fromState: ClarificationStatus.IN_PROGRESS,
        toState: ClarificationStatus.REQUIRED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'clarification.round_completed',
        payload: { clarificationSessionId, projectId, round: session.round },
      });

      const result: CommandResult<ClarificationStatus> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: ClarificationStatus.REQUIRED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
