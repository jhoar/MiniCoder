import { GenerateFeatureBacklogHandler, TransactionalCommandExecutor, generateId } from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { GenerateFeatureBacklogPayload } from './types.js';
import { systemActor } from './actor.js';

export type { GenerateFeatureBacklogPayload };

export interface GenerateFeatureBacklogResult {
  projectId: string;
  featureCount: number;
}

const handler = new GenerateFeatureBacklogHandler();

export async function runImpl(
  payload: GenerateFeatureBacklogPayload,
  db: DbClient,
): Promise<GenerateFeatureBacklogResult> {
  const envelope: CommandEnvelope<typeof payload> = {
    commandId: generateId(),
    idempotencyKey: payload.idempotencyKey,
    payload,
    actor: systemActor(payload.correlationId),
    correlationId: payload.correlationId,
  };

  const executor = new TransactionalCommandExecutor(db);
  await executor.execute(handler, envelope);

  return { projectId: payload.projectId, featureCount: payload.features.length };
}
