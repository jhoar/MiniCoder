import type { DbClient, TxClient } from '../persistence/types.js';

/**
 * Minimal in-memory fake of the tables touched by AdapterRegistry/AgentRunRecorder.
 * Core intentionally has no real DB driver dependency (see no-provider-imports fitness test),
 * so unit tests against these DB-backed classes use this hand-rolled double rather than sqlite.
 */
export class InMemoryAdapterDb implements DbClient {
  readonly agentAdapters: Record<string, unknown>[] = [];
  readonly agentCapabilities: Record<string, unknown>[] = [];
  readonly agentConfigurations: Record<string, unknown>[] = [];
  readonly adapterRevisions: Record<string, unknown>[] = [];
  readonly agentRuns: Record<string, unknown>[] = [];
  readonly agentErrors: Record<string, unknown>[] = [];
  readonly agentContextPacks: Record<string, unknown>[] = [];
  readonly agentToolOperations: Record<string, unknown>[] = [];
  readonly costRecords: Record<string, unknown>[] = [];

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
      // Params: [id, role, name, implementation, is_active, created_at, updated_at]
      // (version=1 is a SQL literal, not a param; ON CONFLICT DO NOTHING is handled below)
      const [id, role, name, implementation, isActive, createdAt, updatedAt] = params;
      const hasConflict = this.agentAdapters.some((r) => r.role === role && r.name === name);
      if (!hasConflict) {
        this.agentAdapters.push({
          id,
          role,
          name,
          implementation,
          is_active: isActive,
          version: 1,
          created_at: createdAt,
          updated_at: updatedAt,
        });
      }
      return;
    }
    if (s.includes('INTO agent_capabilities')) {
      const [id, adapterId, capability, , createdAt, updatedAt] = params;
      this.agentCapabilities.push({
        id,
        adapter_id: adapterId,
        capability,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return;
    }
    if (s.includes('INTO adapter_revisions')) {
      const [
        id,
        adapterId,
        role,
        name,
        implementation,
        version,
        capabilities,
        isActive,
        createdAt,
      ] = params;
      this.adapterRevisions.push({
        id,
        adapter_id: adapterId,
        role,
        name,
        implementation,
        version,
        capabilities,
        is_active: isActive,
        created_at: createdAt,
      });
      return;
    }
    if (s.includes('INTO agent_runs')) {
      // Column order: id, adapter_id, adapter_revision_id, project_id, feature_run_id, role,
      //   state, input_summary, adapter_name, adapter_implementation, adapter_version,
      //   capabilities_used, prompt_template_version, version(literal 1), created_at, updated_at
      const [
        id,
        adapterId,
        adapterRevisionId,
        projectId,
        featureRunId,
        role,
        state,
        inputSummary,
        adapterName,
        adapterImplementation,
        adapterVersion,
        capabilitiesUsed,
        promptTemplateVersion,
        createdAt,
        updatedAt,
      ] = params;
      this.agentRuns.push({
        id,
        adapter_id: adapterId,
        adapter_revision_id: adapterRevisionId,
        project_id: projectId,
        feature_run_id: featureRunId,
        role,
        state,
        input_summary: inputSummary,
        adapter_name: adapterName,
        adapter_implementation: adapterImplementation,
        adapter_version: adapterVersion,
        capabilities_used: capabilitiesUsed,
        prompt_template_version: promptTemplateVersion,
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
    if (s.includes('INTO agent_context_packs')) {
      const [id, agentRunId, content, contentSchemaVersion, createdAt, updatedAt] = params;
      this.agentContextPacks.push({
        id,
        agent_run_id: agentRunId,
        content,
        content_schema_version: contentSchemaVersion,
        version: 1,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return;
    }
    if (s.includes('INTO agent_tool_operations')) {
      const [
        id,
        agentRunId,
        toolName,
        inputSummary,
        outputSummary,
        status,
        durationMs,
        occurredAt,
        createdAt,
      ] = params;
      this.agentToolOperations.push({
        id,
        agent_run_id: agentRunId,
        tool_name: toolName,
        input_summary: inputSummary,
        output_summary: outputSummary,
        status,
        duration_ms: durationMs,
        occurred_at: occurredAt,
        created_at: createdAt,
      });
      return;
    }
    if (s.includes('INTO cost_records')) {
      const [
        id,
        projectId,
        featureRequestId,
        featureRunId,
        agentRunId,
        scope,
        amount,
        provider,
        model,
        inputTokens,
        outputTokens,
        recordedAt,
        createdAt,
        updatedAt,
      ] = params;
      this.costRecords.push({
        id,
        project_id: projectId,
        feature_request_id: featureRequestId,
        feature_run_id: featureRunId,
        agent_run_id: agentRunId,
        scope,
        amount,
        provider,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        recorded_at: recordedAt,
        version: 1,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return;
    }
    throw new Error(`InMemoryAdapterDb: unsupported INSERT: ${s}`);
  }

  private update(s: string, params: unknown[]): void {
    if (s.includes('UPDATE agent_adapters')) {
      const [implementation, isActive, updatedAt, id] = params;
      const row = this.agentAdapters.find((r) => r.id === id);
      if (row)
        Object.assign(row, {
          implementation,
          is_active: isActive,
          version: (Number(row.version) || 1) + 1,
          updated_at: updatedAt,
        });
      return;
    }
    if (s.includes('UPDATE agent_runs') && s.includes('started_at')) {
      const [state, startedAt, updatedAt, id] = params;
      const row = this.agentRuns.find((r) => r.id === id);
      if (row) Object.assign(row, { state, started_at: startedAt, updated_at: updatedAt });
      return;
    }
    if (s.includes('UPDATE agent_runs') && s.includes('output_summary')) {
      // Params: state, outputSummary, endedAt, tokensUsed, costUsd, provider, model, updatedAt, id
      const [state, outputSummary, endedAt, tokensUsed, costUsd, provider, model, updatedAt, id] =
        params;
      const row = this.agentRuns.find((r) => r.id === id);
      if (row) {
        Object.assign(row, {
          state,
          output_summary: outputSummary,
          ended_at: endedAt,
          updated_at: updatedAt,
        });
        if (tokensUsed !== null && tokensUsed !== undefined) row.tokens_used = tokensUsed;
        if (costUsd !== null && costUsd !== undefined) row.cost_usd = costUsd;
        if (provider !== null && provider !== undefined) row.provider = provider;
        if (model !== null && model !== undefined) row.model = model;
      }
      return;
    }
    if (s.includes('UPDATE agent_runs') && s.includes('error')) {
      // Params: state, error, endedAt, tokensUsed, costUsd, provider, model, updatedAt, id
      const [state, error, endedAt, tokensUsed, costUsd, provider, model, updatedAt, id] = params;
      const row = this.agentRuns.find((r) => r.id === id);
      if (row) {
        Object.assign(row, { state, error, ended_at: endedAt, updated_at: updatedAt });
        if (tokensUsed !== null && tokensUsed !== undefined) row.tokens_used = tokensUsed;
        if (costUsd !== null && costUsd !== undefined) row.cost_usd = costUsd;
        if (provider !== null && provider !== undefined) row.provider = provider;
        if (model !== null && model !== undefined) row.model = model;
      }
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
    if (s.startsWith('SELECT version FROM agent_adapters WHERE id')) {
      const [id] = params;
      return this.agentAdapters.filter((r) => r.id === id).map((r) => ({ version: r.version }));
    }
    if (s.includes('FROM agent_adapters WHERE id')) {
      const [id] = params;
      return this.agentAdapters.filter((r) => r.id === id);
    }
    if (s.startsWith('SELECT id FROM adapter_revisions WHERE adapter_id')) {
      const [adapterId, version] = params;
      const matches = this.adapterRevisions.filter(
        (r) => r.adapter_id === adapterId && Number(r.version) === Number(version),
      );
      matches.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
      return matches.slice(0, 1).map((r) => ({ id: r.id }));
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
      // Mirrors the real ORDER BY: project_id IS NULL ASC, version DESC, updated_at DESC.
      matches.sort((a, b) => {
        const nullRank = (a.project_id === null ? 1 : 0) - (b.project_id === null ? 1 : 0);
        if (nullRank !== 0) return nullRank;
        const versionDiff = (Number(b.version) || 0) - (Number(a.version) || 0);
        if (versionDiff !== 0) return versionDiff;
        return String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''));
      });
      return matches.slice(0, 1).map((r) => ({ config: r.config }));
    }
    throw new Error(`InMemoryAdapterDb: unsupported SELECT: ${s}`);
  }
}
