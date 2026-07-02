import {
  StartClarificationHandler,
  TransactionalCommandExecutor,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { StartClarificationPayload } from './types.js';
import { humanActor } from './actor.js';

export type { StartClarificationPayload };

export interface StartClarificationResult {
  projectId: string;
  clarificationSessionId: string;
}

const handler = new StartClarificationHandler();

export async function runImpl(
  payload: StartClarificationPayload,
  db: DbClient,
): Promise<StartClarificationResult> {
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

  return { projectId: payload.projectId, clarificationSessionId: payload.clarificationSessionId };
}
