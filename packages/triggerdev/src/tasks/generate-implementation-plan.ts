import {
  GenerateImplementationPlanHandler,
  TransactionalCommandExecutor,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { GenerateImplementationPlanPayload } from './types.js';
import { systemActor } from './actor.js';

export type { GenerateImplementationPlanPayload };

export interface GenerateImplementationPlanResult {
  projectId: string;
  planId: string | null;
}

const handler = new GenerateImplementationPlanHandler();

export async function runImpl(
  payload: GenerateImplementationPlanPayload,
  db: DbClient,
): Promise<GenerateImplementationPlanResult> {
  const envelope: CommandEnvelope<typeof payload> = {
    commandId: generateId(),
    idempotencyKey: payload.idempotencyKey,
    payload,
    actor: systemActor(payload.correlationId),
    correlationId: payload.correlationId,
  };

  const executor = new TransactionalCommandExecutor(db);
  await executor.execute(handler, envelope);

  const rows = await db.query<{ id: string }>(
    `SELECT id FROM implementation_plans WHERE project_id = ? AND assessment_id = ? ORDER BY created_at DESC LIMIT 1`,
    [payload.projectId, payload.assessmentId],
  );
  return { projectId: payload.projectId, planId: rows[0]?.id ?? null };
}
