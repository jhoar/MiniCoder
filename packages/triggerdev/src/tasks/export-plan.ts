import { ExportPlanHandler, TransactionalCommandExecutor, generateId } from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { ExportPlanPayload } from './types.js';
import { humanActor } from './actor.js';

export type { ExportPlanPayload };

export interface ExportPlanResult {
  projectId: string;
  planId: string;
  artifactExportId: string | null;
}

const handler = new ExportPlanHandler();

export async function runImpl(payload: ExportPlanPayload, db: DbClient): Promise<ExportPlanResult> {
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

  const rows = await db.query<{ id: string }>(
    `SELECT id FROM artifact_exports WHERE project_id = ? AND artifact_type = 'plan' ORDER BY created_at DESC LIMIT 1`,
    [payload.projectId],
  );

  return { projectId: payload.projectId, planId: payload.planId, artifactExportId: rows[0]?.id ?? null };
}
