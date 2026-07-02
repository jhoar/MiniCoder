import { ImportBacklogHandler, TransactionalCommandExecutor, generateId } from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { ImportBacklogPayload } from './types.js';
import { humanActor } from './actor.js';

export type { ImportBacklogPayload };

export interface ImportBacklogResult {
  projectId: string;
  planId: string;
  imported: boolean;
  featureCount: number;
}

const handler = new ImportBacklogHandler();

export async function runImpl(
  payload: ImportBacklogPayload,
  db: DbClient,
): Promise<ImportBacklogResult> {
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
  const result = await executor.execute(handler, envelope);

  return {
    projectId: payload.projectId,
    planId: payload.planId,
    imported: result.resultingState === 'imported',
    featureCount: payload.features.length,
  };
}
