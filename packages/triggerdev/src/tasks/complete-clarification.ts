import {
  BlockClarificationHandler,
  CompleteClarificationHandler,
  RequestAnotherClarificationRoundHandler,
  TransactionalCommandExecutor,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { CompleteClarificationPayload } from './types.js';
import { humanActor, systemActor } from './actor.js';

export type { CompleteClarificationPayload };

export interface CompleteClarificationResult {
  projectId: string;
  clarificationSessionId: string;
  status: 'clarification_complete' | 'clarification_required' | 'clarification_blocked';
}

interface SessionRow {
  round: number;
  max_rounds: number;
}

const completeHandler = new CompleteClarificationHandler();
const requestAnotherRoundHandler = new RequestAnotherClarificationRoundHandler();
const blockHandler = new BlockClarificationHandler();

/**
 * Orchestrates the post-round decision: sufficient readiness completes the session; insufficient
 * readiness either opens another round (round budget remaining) or trips the circuit breaker
 * (docs/02 §4). This is command *sequencing*, not domain logic — the guards and transitions
 * themselves live in the dispatched command handlers.
 */
export async function runImpl(
  payload: CompleteClarificationPayload,
  db: DbClient,
): Promise<CompleteClarificationResult> {
  const { clarificationSessionId, projectId, expectedVersion, readinessResult } = payload;

  if (readinessResult === 'sufficient' || readinessResult === 'sufficient_with_assumptions') {
    const envelope: CommandEnvelope<typeof payload> = {
      commandId: generateId(),
      idempotencyKey: payload.idempotencyKey,
      payload,
      actor: humanActor({
        actorId: payload.actorId,
        actorRole: payload.actorRole,
        correlationId: payload.correlationId,
      }),
      correlationId: payload.correlationId,
    };
    const executor = new TransactionalCommandExecutor(db);
    await executor.execute(completeHandler, envelope);
    return { projectId, clarificationSessionId, status: 'clarification_complete' };
  }

  const sessionRows = await db.query<SessionRow>(
    `SELECT round, max_rounds FROM clarification_sessions WHERE id = ? AND project_id = ?`,
    [clarificationSessionId, projectId],
  );
  const session = sessionRows[0];
  const roundBudgetRemaining = !!session && session.round < session.max_rounds;

  const systemPayload = { clarificationSessionId, projectId, expectedVersion };
  const envelope: CommandEnvelope<typeof systemPayload> = {
    commandId: generateId(),
    idempotencyKey: payload.idempotencyKey,
    payload: systemPayload,
    actor: systemActor(payload.correlationId),
    correlationId: payload.correlationId,
  };
  const executor = new TransactionalCommandExecutor(db);

  if (roundBudgetRemaining) {
    await executor.execute(requestAnotherRoundHandler, envelope);
    return { projectId, clarificationSessionId, status: 'clarification_required' };
  }

  const blockEnvelope: CommandEnvelope<typeof systemPayload & { reason: 'round_limit_exceeded' }> =
    {
      ...envelope,
      payload: { ...systemPayload, reason: 'round_limit_exceeded' },
    };
  await executor.execute(blockHandler, blockEnvelope);
  return { projectId, clarificationSessionId, status: 'clarification_blocked' };
}
