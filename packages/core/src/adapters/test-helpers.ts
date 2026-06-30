import type { DbClient, TxClient } from '../persistence/types.js';

/**
 * Minimal in-memory fake of the four tables touched by AdapterRegistry/AgentRunRecorder.
 * Core intentionally has no real DB driver dependency (see no-provider-imports fitness test),
 * so unit tests against these DB-backed classes use this hand-rolled double rather than sqlite.
 */
export class InMemoryAdapterDb implements DbClient {
  readonly agentAdapters: Record<string, unknown>[] = [];
  readonly agentCapabilities: Record<string, unknown>[] = [];
  readonly agentConfigurations: Record<string, unknown>[] = [];
  readonly agentRuns: Record<string, unknown>[] = [];
  readonly agentErrors: Record<string, unknown>[] = [];

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.dispatch(sql, params) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.dispatch(sql, params);
  }

  async executeAffected(sql: string, params: unknown[] = []): Promise<number> {
    const result = this.dispatch(sql, params);
    return Array.isArray(result) ? result.length : (result as number);
  }

  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}

  private dispatch(sql: string, params: unknown[]): unknown {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT')) return this.select(s, params);
    if (s.startsWith('INSERT')) return this.insert(s, params);
    if (s.startsWith('UPDATE')) return this.update(s, params);
    if (s.startsWith('DELETE')) return this.delete(s, params);
    throw new Error(`InMemoryAdapterDb: unsupported SQL: ${s}`);
  }

  private insert(s: string, params: unknown[]): void {
    if (s.includes('INTO agent_adapters')) {
      const [id, role, name, implementation, isActive, createdAt, updatedAt] = params;
      this.agentAdapters.push({
        id,
        role,
        name,
        implementation,
        is_active: isActive,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return;
    }
    if (s.includes('INTO agent_capabilities')) {
      const [id, adapterId, capability, createdAt, updatedAt] = params;
      this.agentCapabilities.push({
        id,
        adapter_id: adapterId,
        capability,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return;
    }
    if (s.includes('INTO agent_runs')) {
      const [
        id,
        adapterId,
        projectId,
        featureRunId,
        role,
        state,
        inputSummary,
        createdAt,
        updatedAt,
      ] = params;
      this.agentRuns.push({
        id,
        adapter_id: adapterId,
        project_id: projectId,
        feature_run_id: featureRunId,
        role,
        state,
        input_summary: inputSummary,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return;
    }
    if (s.includes('INTO agent_errors')) {
      const [id, agentRunId, errorType, message, occurredAt, createdAt] = params;
      this.agentErrors.push({
        id,
        agent_run_id: agentRunId,
        error_type: errorType,
        message,
        occurred_at: occurredAt,
        created_at: createdAt,
      });
      return;
    }
    throw new Error(`InMemoryAdapterDb: unsupported INSERT: ${s}`);
  }

  private update(s: string, params: unknown[]): void {
    if (s.includes('UPDATE agent_adapters')) {
      const [implementation, isActive, updatedAt, id] = params;
      const row = this.agentAdapters.find((r) => r.id === id);
      if (row) Object.assign(row, { implementation, is_active: isActive, updated_at: updatedAt });
      return;
    }
    if (s.includes('UPDATE agent_runs') && s.includes('started_at')) {
      const [state, startedAt, updatedAt, id] = params;
      const row = this.agentRuns.find((r) => r.id === id);
      if (row) Object.assign(row, { state, started_at: startedAt, updated_at: updatedAt });
      return;
    }
    if (s.includes('UPDATE agent_runs') && s.includes('output_summary')) {
      const [state, outputSummary, endedAt, updatedAt, id] = params;
      const row = this.agentRuns.find((r) => r.id === id);
      if (row)
        Object.assign(row, {
          state,
          output_summary: outputSummary,
          ended_at: endedAt,
          updated_at: updatedAt,
        });
      return;
    }
    if (s.includes('UPDATE agent_runs') && s.includes('error')) {
      const [state, error, endedAt, updatedAt, id] = params;
      const row = this.agentRuns.find((r) => r.id === id);
      if (row) Object.assign(row, { state, error, ended_at: endedAt, updated_at: updatedAt });
      return;
    }
    throw new Error(`InMemoryAdapterDb: unsupported UPDATE: ${s}`);
  }

  private delete(s: string, params: unknown[]): void {
    if (s.includes('FROM agent_capabilities')) {
      const [adapterId] = params;
      const remaining = this.agentCapabilities.filter((r) => r.adapter_id !== adapterId);
      this.agentCapabilities.length = 0;
      this.agentCapabilities.push(...remaining);
      return;
    }
    throw new Error(`InMemoryAdapterDb: unsupported DELETE: ${s}`);
  }

  private select(s: string, params: unknown[]): Record<string, unknown>[] {
    if (s.startsWith('SELECT id FROM agent_adapters WHERE role')) {
      const [role, name] = params;
      return this.agentAdapters
        .filter((r) => r.role === role && r.name === name)
        .map((r) => ({ id: r.id }));
    }
    if (s.includes('FROM agent_adapters WHERE role') && s.includes('AND name')) {
      const [role, name] = params;
      return this.agentAdapters.filter((r) => r.role === role && r.name === name);
    }
    if (s.includes('FROM agent_adapters WHERE id')) {
      const [id] = params;
      return this.agentAdapters.filter((r) => r.id === id);
    }
    if (s.startsWith('SELECT capability FROM agent_capabilities')) {
      const [adapterId] = params;
      return this.agentCapabilities
        .filter((r) => r.adapter_id === adapterId)
        .map((r) => ({ capability: r.capability }));
    }
    if (s.startsWith('SELECT config FROM agent_configurations')) {
      const [adapterId, projectId] = params;
      const matches = this.agentConfigurations.filter(
        (r) => r.adapter_id === adapterId && (r.project_id === projectId || r.project_id === null),
      );
      matches.sort((a, b) => (a.project_id === null ? 1 : 0) - (b.project_id === null ? 1 : 0));
      return matches.slice(0, 1).map((r) => ({ config: r.config }));
    }
    throw new Error(`InMemoryAdapterDb: unsupported SELECT: ${s}`);
  }
}
