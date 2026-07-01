import { ActivatePlanHandler, TransactionalCommandExecutor, generateId } from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { ActivateApprovedBacklogPayload } from './types.js';
import { humanActor } from './actor.js';

export type { ActivateApprovedBacklogPayload };

export interface ActivateApprovedBacklogResult {
  projectId: string;
  planId: string;
  activatedFeatureCount: number;
}

const handler = new ActivatePlanHandler();

export async function runImpl(
  payload: ActivateApprovedBacklogPayload,
  db: DbClient,
): Promise<ActivateApprovedBacklogResult> {
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

  const rows = await db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE freq.plan_id = ?`,
    [payload.planId],
  );
  const activatedFeatureCount = Number(rows[0]?.count ?? 0);

  return { projectId: payload.projectId, planId: payload.planId, activatedFeatureCount };
}
