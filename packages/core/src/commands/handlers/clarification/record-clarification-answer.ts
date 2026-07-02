import { z } from 'zod';
import { ClarificationStatus, UserRole } from '../../../domain/states.js';
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

export const RecordClarificationAnswerPayloadSchema = z.object({
  clarificationQuestionId: z.string(),
  clarificationSessionId: z.string(),
  projectId: z.string(),
  answer: z.string(),
  expectedQuestionVersion: z.number().int().nonnegative(),
});
export type RecordClarificationAnswerPayload = z.infer<
  typeof RecordClarificationAnswerPayloadSchema
>;

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface QuestionRow {
  id: string;
  version: number;
  answered_at: string | null;
}

interface SessionRow {
  status: string;
}

/**
 * Data-only command: records an answer for one clarification round question. It does not
 * transition clarification_sessions.status — that only happens via CompleteClarificationCommand
 * once every question in the current round has an answer.
 */
export class RecordClarificationAnswerHandler implements CommandHandler<
  RecordClarificationAnswerPayload,
  ClarificationStatus
> {
  readonly commandName = 'RecordClarificationAnswerCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'record-clarification-answer';

  async execute(
    envelope: CommandEnvelope<RecordClarificationAnswerPayload>,
    db: DbClient,
  ): Promise<CommandResult<ClarificationStatus>> {
    const {
      clarificationQuestionId,
      clarificationSessionId,
      projectId,
      answer,
      expectedQuestionVersion,
    } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<ClarificationStatus>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const sessionRows = await tx.query<SessionRow>(
        `SELECT status FROM clarification_sessions WHERE id = ? AND project_id = ?`,
        [clarificationSessionId, projectId],
      );
      const session = sessionRows[0];
      if (!session) {
        throw new CommandError({
          type: 'not-found',
          title: 'Clarification session not found',
          status: 404,
          detail: `Clarification session ${clarificationSessionId} not found in project ${projectId}`,
          instance: envelope.correlationId,
        });
      }

      const questionRows = await tx.query<QuestionRow>(
        `SELECT id, version, answered_at FROM clarification_questions
         WHERE id = ? AND clarification_session_id = ?`,
        [clarificationQuestionId, clarificationSessionId],
      );
      const question = questionRows[0];
      if (!question) {
        throw new CommandError({
          type: 'not-found',
          title: 'Clarification question not found',
          status: 404,
          detail: `Clarification question ${clarificationQuestionId} not found in session ${clarificationSessionId}`,
          instance: envelope.correlationId,
        });
      }
      assertVersion(
        'clarification_questions',
        clarificationQuestionId,
        question,
        expectedQuestionVersion,
      );
      if (question.answered_at !== null) {
        throw new CommandError({
          type: 'already-answered',
          title: 'Clarification question already answered',
          status: 409,
          detail: `Clarification question ${clarificationQuestionId} already has an answer`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      const newVersion = nextVersion(question.version);

      const affected = await tx.executeAffected(
        `UPDATE clarification_questions SET answered_at = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [now, newVersion, now, clarificationQuestionId, expectedQuestionVersion],
      );
      if (affected === 0) {
        throw new OptimisticLockError(
          'clarification_questions',
          clarificationQuestionId,
          expectedQuestionVersion,
          -1,
        );
      }

      await tx.execute(
        `INSERT INTO clarification_answers
           (id, clarification_question_id, answer, actor, actor_role, answered_at, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          generateId(),
          clarificationQuestionId,
          answer,
          envelope.actor.id,
          envelope.actor.role,
          now,
          now,
          now,
        ],
      );

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'clarification.answered',
        fromState: session.status,
        toState: session.status,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'clarification.answered',
        payload: { clarificationQuestionId, clarificationSessionId, projectId },
      });

      const result: CommandResult<ClarificationStatus> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: session.status as ClarificationStatus,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
