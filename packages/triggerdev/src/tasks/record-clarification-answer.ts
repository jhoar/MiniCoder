import {
  RecordClarificationAnswerHandler,
  TransactionalCommandExecutor,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { RecordClarificationAnswerPayload } from './types.js';
import { humanActor } from './actor.js';

export type { RecordClarificationAnswerPayload };

export interface RecordClarificationAnswerResult {
  projectId: string;
  clarificationQuestionId: string;
}

const handler = new RecordClarificationAnswerHandler();

export async function runImpl(
  payload: RecordClarificationAnswerPayload,
  db: DbClient,
): Promise<RecordClarificationAnswerResult> {
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
  await executor.execute(handler, envelope);

  return { projectId: payload.projectId, clarificationQuestionId: payload.clarificationQuestionId };
}
