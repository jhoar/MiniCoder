import {
  IngestSpecificationHandler,
  TransactionalCommandExecutor,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { IngestSpecificationPayload } from './types.js';
import { humanActor } from './actor.js';

export type { IngestSpecificationPayload };

export interface IngestSpecificationResult {
  projectId: string;
  specificationInputId: string | null;
}

const handler = new IngestSpecificationHandler();

export async function runImpl(
  payload: IngestSpecificationPayload,
  db: DbClient,
): Promise<IngestSpecificationResult> {
  const envelope: CommandEnvelope<IngestSpecificationPayload> = {
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

  return { projectId: payload.projectId, specificationInputId: null };
}
