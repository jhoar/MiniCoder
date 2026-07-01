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

export const StartClarificationPayloadSchema = z.object({
  clarificationSessionId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});
export type StartClarificationPayload = z.infer<typeof StartClarificationPayloadSchema>;

const validator = new StateTransitionValidator(CLARIFICATION_MATRIX, 'clarification');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUESTIONS = 7;

interface SessionRow {
  id: string;
  status: string;
  round: number;
  max_rounds: number;
  version: number;
}

interface OpenQuestionRow {
  id: string;
  question: string;
}

/**
 * clarification_required -> clarification_in_progress. Round is incremented here, at the point a
 * fresh round of questions is actually asked — not on RequestAnotherClarificationRoundCommand —
 * so the round counter reflects rounds consumed, matching the "round count < max_rounds" guard
 * text used by both this transition and BlockClarificationCommand.
 */
export class StartClarificationHandler
  implements CommandHandler<StartClarificationPayload, ClarificationStatus>
{
  readonly commandName = 'StartClarificationCommand';
  readonly requiredRole = UserRole.OPERATOR;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'start-clarification';

  async execute(
    envelope: CommandEnvelope<StartClarificationPayload>,
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
      validator.assertValid(
        session.status as ClarificationStatus,
        ClarificationStatus.IN_PROGRESS,
      );

      if (session.round >= session.max_rounds) {
        throw new CommandError({
          type: 'clarification-round-limit',
          title: 'Clarification round limit reached',
          status: 409,
          detail: `Session ${clarificationSessionId} has already used ${session.round}/${session.max_rounds} rounds`,
          instance: envelope.correlationId,
        });
      }

      const newRound = session.round + 1;
      const newVersion = nextVersion(session.version);
      const now = isoNow();

      const affected = await tx.executeAffected(
        `UPDATE clarification_sessions SET status = ?, round = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [ClarificationStatus.IN_PROGRESS, newRound, newVersion, now, clarificationSessionId, expectedVersion],
      );
      if (affected === 0) {
        throw new OptimisticLockError('clarification_sessions', clarificationSessionId, expectedVersion, -1);
      }

      // Prioritized open planning_questions (recommended 3-7 per round, docs/02 §4) become this
      // round's clarification_questions.
      const openQuestions = await tx.query<OpenQuestionRow>(
        `SELECT pq.id, pq.question
         FROM planning_questions pq
         JOIN planning_readiness_assessments a ON pq.assessment_id = a.id
         WHERE a.project_id = ? AND pq.answer IS NULL
         ORDER BY pq.round ASC, pq.id ASC
         LIMIT ?`,
        [projectId, MAX_QUESTIONS],
      );

      for (let i = 0; i < openQuestions.length; i++) {
        const q = openQuestions[i]!;
        await tx.execute(
          `INSERT INTO clarification_questions
             (id, clarification_session_id, question, round, order_index, asked_at, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [generateId(), clarificationSessionId, q.question, newRound, i, now, now, now],
        );
      }

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'clarification.started',
        fromState: ClarificationStatus.REQUIRED,
        toState: ClarificationStatus.IN_PROGRESS,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'clarification.started',
        payload: { clarificationSessionId, projectId, round: newRound },
      });

      const result: CommandResult<ClarificationStatus> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: ClarificationStatus.IN_PROGRESS,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
