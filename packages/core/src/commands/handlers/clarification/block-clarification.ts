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

export const BlockClarificationPayloadSchema = z.object({
  clarificationSessionId: z.string(),
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.enum(['round_limit_exceeded', 'round_timeout']),
});
export type BlockClarificationPayload = z.infer<typeof BlockClarificationPayloadSchema>;

const validator = new StateTransitionValidator(CLARIFICATION_MATRIX, 'clarification');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionRow {
  id: string;
  status: string;
  round: number;
  max_rounds: number;
  round_timeout_at: string | null;
  version: number;
}

/**
 * The clarification circuit breaker (docs/02 §4): (clarification_required |
 * clarification_in_progress) -> clarification_blocked when the round limit or per-round timeout
 * is exceeded. Trips a human_required escalation by recording a clarification_decisions row —
 * surfacing it to an operator is an API/UI concern (Phase 13+).
 */
export class BlockClarificationHandler implements CommandHandler<
  BlockClarificationPayload,
  ClarificationStatus
> {
  readonly commandName = 'BlockClarificationCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'block-clarification';

  async execute(
    envelope: CommandEnvelope<BlockClarificationPayload>,
    db: DbClient,
  ): Promise<CommandResult<ClarificationStatus>> {
    const { clarificationSessionId, projectId, expectedVersion, reason } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<ClarificationStatus>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const rows = await tx.query<SessionRow>(
        `SELECT id, status, round, max_rounds, round_timeout_at, version FROM clarification_sessions
         WHERE id = ? AND project_id = ?`,
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
      const fromState = session.status as ClarificationStatus;
      validator.assertValid(fromState, ClarificationStatus.BLOCKED);

      const now = isoNow();
      if (reason === 'round_limit_exceeded' && session.round < session.max_rounds) {
        throw new CommandError({
          type: 'round-limit-not-exceeded',
          title: 'Round limit not yet exceeded',
          status: 409,
          detail: `Session ${clarificationSessionId} has used ${session.round}/${session.max_rounds} rounds`,
          instance: envelope.correlationId,
        });
      }
      if (
        reason === 'round_timeout' &&
        (!session.round_timeout_at || session.round_timeout_at > now)
      ) {
        throw new CommandError({
          type: 'timeout-not-exceeded',
          title: 'Round timeout not yet exceeded',
          status: 409,
          detail: `Session ${clarificationSessionId} has not exceeded its round timeout`,
          instance: envelope.correlationId,
        });
      }

      const affected = await tx.executeAffected(
        `UPDATE clarification_sessions SET status = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          ClarificationStatus.BLOCKED,
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
         VALUES (?, ?, 'block', ?, ?, ?, ?, 1, ?, ?)`,
        [
          generateId(),
          clarificationSessionId,
          envelope.actor.id,
          envelope.actor.role,
          reason,
          now,
          now,
          now,
        ],
      );

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'clarification.blocked',
        fromState,
        toState: ClarificationStatus.BLOCKED,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'clarification.blocked',
        payload: { clarificationSessionId, projectId, reason },
      });

      const result: CommandResult<ClarificationStatus> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: ClarificationStatus.BLOCKED,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
