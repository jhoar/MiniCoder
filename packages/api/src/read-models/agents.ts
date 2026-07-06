/**
 * Read models for "agent runs", "agent adapters", and "agent configuration" (docs/01 §9).
 */
import type { DbClient } from '@minicoder/core';
import { listByCreatedAt, type CursorPage, type ListParams } from '../pagination.js';
import { getByIdOrThrow } from './helpers.js';

export interface AgentRunRow {
  id: string;
  adapter_id: string;
  project_id: string | null;
  feature_run_id: string | null;
  role: string;
  state: string;
  input_summary: string | null;
  output_summary: string | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
  tokens_used: number | null;
  cost_usd: number | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const AGENT_RUN_COLUMNS =
  'id, adapter_id, project_id, feature_run_id, role, state, input_summary, output_summary, error, started_at, ended_at, tokens_used, cost_usd, version, created_at, updated_at';

export function listAgentRuns(
  db: DbClient,
  filters: { projectId?: string; featureRunId?: string },
  params: ListParams,
): Promise<CursorPage<AgentRunRow>> {
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
  return listByCreatedAt<AgentRunRow>(
    db,
    {
      table: 'agent_runs',
      columns: AGENT_RUN_COLUMNS,
      where: clauses.length > 0 ? clauses.join(' AND ') : undefined,
      params: queryParams,
    },
    params,
  );
}

export function getAgentRun(db: DbClient, id: string): Promise<AgentRunRow> {
  return getByIdOrThrow<AgentRunRow>(db, 'agent_runs', AGENT_RUN_COLUMNS, id, 'agent-run');
}

export interface AgentAdapterRow {
  id: string;
  role: string;
  name: string;
  implementation: string;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listAgentAdapters(
  db: DbClient,
  params: ListParams,
): Promise<CursorPage<AgentAdapterRow>> {
  return listByCreatedAt<AgentAdapterRow>(
    db,
    {
      table: 'agent_adapters',
      columns: 'id, role, name, implementation, is_active, version, created_at, updated_at',
    },
    params,
  );
}

export interface AgentConfigurationRow {
  id: string;
  adapter_id: string;
  project_id: string | null;
  config: unknown;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listAgentConfigurations(
  db: DbClient,
  adapterId: string | undefined,
  params: ListParams,
): Promise<CursorPage<AgentConfigurationRow>> {
  return listByCreatedAt<AgentConfigurationRow>(
    db,
    {
      table: 'agent_configurations',
      columns: 'id, adapter_id, project_id, config, version, created_at, updated_at',
      where: adapterId ? 'adapter_id = ?' : undefined,
      params: adapterId ? [adapterId] : [],
    },
    params,
  );
}
