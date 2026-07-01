import { ValidateBacklogHandler, TransactionalCommandExecutor, generateId } from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { ValidateBacklogPayload } from './types.js';
import { systemActor } from './actor.js';

export type { ValidateBacklogPayload };

export interface ValidateBacklogResult {
  projectId: string;
  planId: string;
  valid: boolean;
}

const handler = new ValidateBacklogHandler();

export async function runImpl(
  payload: ValidateBacklogPayload,
  db: DbClient,
): Promise<ValidateBacklogResult> {
  const envelope: CommandEnvelope<typeof payload> = {
    commandId: generateId(),
    idempotencyKey: payload.idempotencyKey,
    payload,
    actor: systemActor(payload.correlationId),
    correlationId: payload.correlationId,
  };

  const executor = new TransactionalCommandExecutor(db);
  let valid = true;
  try {
    await executor.execute(handler, envelope);
  } catch {
    // ValidateBacklogHandler throws a 422 CommandError for an invalid backlog after persisting
    // the failed workflow_event — surface that as a structured result rather than a task failure.
    valid = false;
  }

  return { projectId: payload.projectId, planId: payload.planId, valid };
}
