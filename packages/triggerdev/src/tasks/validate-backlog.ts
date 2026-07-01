import {
  ValidateBacklogHandler,
  TransactionalCommandExecutor,
  CommandError,
  generateId,
} from '@minicoder/core';
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
  } catch (err) {
    // ValidateBacklogHandler throws a 422 CommandError (type 'backlog-invalid') for an invalid
    // backlog after persisting the failed workflow_event — surface only that expected outcome as
    // a structured result. Every other error (DB failure, not-found, programmer error) must
    // propagate so Trigger.dev's retry/failed-status handling in makeTaskRunner applies to it.
    if (err instanceof CommandError && err.problem.type === 'backlog-invalid') {
      valid = false;
    } else {
      throw err;
    }
  }

  return { projectId: payload.projectId, planId: payload.planId, valid };
}
