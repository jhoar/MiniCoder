import { ExportBacklogHandler, TransactionalCommandExecutor, generateId } from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import type { ExportBacklogPayload } from './types.js';
import { humanActor } from './actor.js';

export type { ExportBacklogPayload };

export interface ExportBacklogResult {
  projectId: string;
  artifactExportId: string | null;
  featureCount: number;
}

const handler = new ExportBacklogHandler();

export async function runImpl(
  payload: ExportBacklogPayload,
  db: DbClient,
): Promise<ExportBacklogResult> {
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

  const [exportRows, featureRows] = await Promise.all([
    db.query<{ id: string }>(
      `SELECT id FROM artifact_exports WHERE project_id = ? AND artifact_type = 'backlog' ORDER BY created_at DESC LIMIT 1`,
      [payload.projectId],
    ),
    db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM feature_requests WHERE project_id = ? AND plan_id = ?`,
      [payload.projectId, payload.planId],
    ),
  ]);

  return {
    projectId: payload.projectId,
    artifactExportId: exportRows[0]?.id ?? null,
    featureCount: Number(featureRows[0]?.count ?? 0),
  };
}
