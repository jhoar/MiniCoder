import {
  SubmitPlanForApprovalHandler,
  TransactionalCommandExecutor,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { RequestPlanApprovalPayload } from './types.js';
import { humanActor } from './actor.js';

export type { RequestPlanApprovalPayload };

export interface RequestPlanApprovalResult {
  projectId: string;
  planId: string;
}

const handler = new SubmitPlanForApprovalHandler();

export async function runImpl(
  payload: RequestPlanApprovalPayload,
  db: DbClient,
): Promise<RequestPlanApprovalResult> {
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

  return { projectId: payload.projectId, planId: payload.planId };
}
