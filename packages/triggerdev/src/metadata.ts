import type { DbClient } from '@minicoder/core';

export interface TriggerRunLink {
  triggerdevRunId: string;
  triggerdevTaskId: string;
  triggerdevStatus: string;
  projectId?: string;
  linkedWorkflowEventId?: string;
  linkedAgentRunId?: string;
  linkedFeatureRunId?: string;
}

function generateId(): string {
  return `tdr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function linkRunToDb(db: DbClient, link: TriggerRunLink): Promise<string> {
  const id = generateId();
  const now = new Date().toISOString();
  // Upsert so retries (same triggerdev_run_id) reset status to 'running' rather than
  // colliding with the UNIQUE constraint. The original row id and created_at are preserved.
  await db.execute(
    `INSERT INTO triggerdev_runs
       (id, triggerdev_run_id, triggerdev_task_id, triggerdev_status,
        project_id, linked_workflow_event_id, linked_agent_run_id, linked_feature_run_id,
        last_seen_at, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(triggerdev_run_id) DO UPDATE SET
       triggerdev_status = 'running',
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`,
    [
      id,
      link.triggerdevRunId,
      link.triggerdevTaskId,
      link.triggerdevStatus,
      link.projectId ?? null,
      link.linkedWorkflowEventId ?? null,
      link.linkedAgentRunId ?? null,
      link.linkedFeatureRunId ?? null,
      now,
      now,
      now,
    ],
  );
  // Return the actual row id, which may differ from the generated id on conflict.
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM triggerdev_runs WHERE triggerdev_run_id = ?`,
    [link.triggerdevRunId],
  );
  return rows[0]!.id;
}

export async function updateRunStatus(
  db: DbClient,
  triggerdevRunId: string,
  status: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(
    `UPDATE triggerdev_runs
     SET triggerdev_status = ?, last_seen_at = ?, updated_at = ?
     WHERE triggerdev_run_id = ?`,
    [status, now, now, triggerdevRunId],
  );
}

export async function getRunByTriggerdevId(
  db: DbClient,
  triggerdevRunId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM triggerdev_runs WHERE triggerdev_run_id = ?`,
    [triggerdevRunId],
  );
  return rows[0];
}
