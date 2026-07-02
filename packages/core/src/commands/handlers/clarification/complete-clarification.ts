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
  generateId,
  writeWorkflowEvent,
  writeOutboxEvent,
  claimIdempotencyKey,
  fulfillIdempotencyKey,
} from '../../helpers.js';

export const CompleteClarificationPayloadSchema = z.object({
  clarificationSessionId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type CompleteClarificationPayload = z.infer<typeof CompleteClarificationPayloadSchema>;

const validator = new StateTransitionValidator(CLARIFICATION_MATRIX, 'clarification');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionRow {
  id: string;
  status: string;
  round: number;
  version: number;
}

/** clarification_in_progress -> clarification_complete, once every question in the current round has an answer. */
export class CompleteClarificationHandler implements CommandHandler<
  CompleteClarificationPayload,
  ClarificationStatus
> {
  readonly commandName = 'CompleteClarificationCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'complete-clarification';

  async execute(
    envelope: CommandEnvelope<CompleteClarificationPayload>,
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
        `SELECT id, status, round, version FROM clarification_sessions WHERE id = ? AND project_id = ?`,
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
      validator.assertValid(session.status as ClarificationStatus, ClarificationStatus.COMPLETE);

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
        [
          ClarificationStatus.COMPLETE,
          nextVersion(session.version),
          now,
          clarificationSessionId,
          expectedVersion,
        ],
      );
      if (affected === 0) {
        throw new OptimisticLockError(
          'clarification_sessions',
          clarificationSessionId,
          expectedVersion,
          -1,
        );
      }

      await tx.execute(
        `INSERT INTO clarification_decisions
           (id, clarification_session_id, decision_type, actor, actor_role, notes, decided_at, version, created_at, updated_at)
         VALUES (?, ?, 'proceed', ?, ?, NULL, ?, 1, ?, ?)`,
        [
          generateId(),
          clarificationSessionId,
          envelope.actor.id,
          envelope.actor.role,
          now,
          now,
          now,
        ],
      );

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'clarification.complete',
        fromState: ClarificationStatus.IN_PROGRESS,
        toState: ClarificationStatus.COMPLETE,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'clarification.complete',
        payload: { clarificationSessionId, projectId },
      });

      const result: CommandResult<ClarificationStatus> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: ClarificationStatus.COMPLETE,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
