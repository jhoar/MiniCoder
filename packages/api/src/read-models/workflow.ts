/**
 * Read models for "workflow events", "merge gate evaluations", and "status" (docs/01 §9).
 * `merge_gate_evaluations` is added as an explicit read group beyond docs/01's original list —
 * it has existed as a table with a production writer since Phase 12 and has no other read path.
 */
import type { DbClient } from '@minicoder/core';
import { listByCreatedAt, type CursorPage, type ListParams } from '../pagination.js';

export interface WorkflowEventRow {
  id: string;
  feature_run_id: string | null;
  project_id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  actor: string | null;
  payload: unknown;
  payload_schema_version: string;
  occurred_at: string;
  created_at: string;
}

export function listWorkflowEvents(
  db: DbClient,
  filters: { projectId?: string; featureRunId?: string },
  params: ListParams,
): Promise<CursorPage<WorkflowEventRow>> {
  const clauses: string[] = [];
  const queryParams: unknown[] = [];
  if (filters.projectId) {
    clauses.push('project_id = ?');
    queryParams.push(filters.projectId);
  }
  if (filters.featureRunId) {
    clauses.push('feature_run_id = ?');
    queryParams.push(filters.featureRunId);
  }
  return listByCreatedAt<WorkflowEventRow>(
    db,
    {
      table: 'workflow_events',
      columns:
        'id, feature_run_id, project_id, event_type, from_state, to_state, actor, payload, payload_schema_version, occurred_at, created_at',
      where: clauses.length > 0 ? clauses.join(' AND ') : undefined,
      params: queryParams,
    },
    params,
  );
}

export interface MergeGateEvaluationRow {
  id: string;
  feature_run_id: string;
  ci_status: string | null;
  review_status: string | null;
  unresolved_blocking_findings: number;
  budget_status: string | null;
  human_approval_required: boolean;
  human_approval_id: string | null;
  branch_protection_ok: boolean;
  final_decision: string;
  evaluated_at: string;
  created_at: string;
}

export function listMergeGateEvaluations(
  db: DbClient,
  featureRunId: string,
  params: ListParams,
): Promise<CursorPage<MergeGateEvaluationRow>> {
  return listByCreatedAt<MergeGateEvaluationRow>(
    db,
    {
      table: 'merge_gate_evaluations',
      columns:
        'id, feature_run_id, ci_status, review_status, unresolved_blocking_findings, budget_status, human_approval_required, human_approval_id, branch_protection_ok, final_decision, evaluated_at, created_at',
      where: 'feature_run_id = ?',
      params: [featureRunId],
    },
    params,
  );
}

/** "status" group: a coarse-grained project health summary (mirrors `state inspect`). */
export async function getProjectStatus(
  db: DbClient,
  projectId: string,
): Promise<{
  project: { id: string; name: string; state: string; version: number } | null;
  workflowState: {
    automation_state: string;
    active_feature_run_id: string | null;
    version: number;
  } | null;
  pendingOutboxCount: number;
}> {
  // Phase 17: `version` is additive (mirrors Phase 15's identical addition to `workflowState`
  // above) — every project-lifecycle write command (`MarkImplementationCompleteCommand`,
  // `CompleteProjectCommand`, etc.) requires `expectedVersion`, and there was previously no way
  // to read the current `projects.version` through the API at all.
  const projectRows = await db.query<{ id: string; name: string; state: string; version: number }>(
    'SELECT id, name, state, version FROM projects WHERE id = ?',
    [projectId],
  );
  const wsRows = await db.query<{
    automation_state: string;
    active_feature_run_id: string | null;
    version: number;
  }>(
    'SELECT automation_state, active_feature_run_id, version FROM workflow_states WHERE project_id = ?',
    [projectId],
  );
  const outboxRows = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM outbox_events WHERE status IN ('pending', 'processing')`,
    [],
  );
  return {
    project: projectRows[0] ?? null,
    workflowState: wsRows[0] ?? null,
    pendingOutboxCount: outboxRows[0]?.cnt ?? 0,
  };
}

export interface TriggerdevRunRow {
  id: string;
  triggerdev_run_id: string;
  triggerdev_task_id: string;
  triggerdev_status: string;
  project_id: string | null;
  linked_feature_run_id: string | null;
  last_seen_at: string;
  created_at: string;
}

/**
 * Workflow-Layer (Trigger.dev) run/task status (docs/05 §6). Surfaces exactly the columns that
 * exist on `triggerdev_runs` today — there is no retry-count/waitpoint-reason column in the
 * schema, so those fields are not fabricated here; see CLAUDE.md's Ink Text UI Operational
 * Constraints for the documented gap.
 */
export function listTriggerdevRuns(
  db: DbClient,
  filters: { projectId?: string; featureRunId?: string },
  params: ListParams,
): Promise<CursorPage<TriggerdevRunRow>> {
  const clauses: string[] = [];
  const queryParams: unknown[] = [];
  if (filters.projectId) {
    clauses.push('project_id = ?');
    queryParams.push(filters.projectId);
  }
  if (filters.featureRunId) {
    clauses.push('linked_feature_run_id = ?');
    queryParams.push(filters.featureRunId);
  }
  return listByCreatedAt<TriggerdevRunRow>(
    db,
    {
      table: 'triggerdev_runs',
      columns:
        'id, triggerdev_run_id, triggerdev_task_id, triggerdev_status, project_id, linked_feature_run_id, last_seen_at, created_at',
      where: clauses.length > 0 ? clauses.join(' AND ') : undefined,
      params: queryParams,
    },
    params,
  );
}
