import type { DbClient } from '../persistence/types.js';
import { generateId, isoNow } from '../commands/helpers.js';
import { defaultRedactor, type SecretRedactor } from '../auth/redaction.js';
import { AgentRunState } from '../domain/states.js';
import { StateTransitionValidator } from '../statemachine/validator.js';
import { AGENT_RUN_MATRIX } from '../statemachine/machines/agent-run.js';
import type { AdapterRegistry } from './registry.js';

/** Normalized provider-failure taxonomy (docs/03 §11.6). */
export type AgentRunErrorType =
  | 'timeout'
  | 'rate_limited'
  | 'invalid_output'
  | 'auth'
  | 'provider_unavailable'
  | 'cancelled';

export class AdapterRunError extends Error {
  constructor(
    public readonly errorType: AgentRunErrorType,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterRunError';
  }
}

/**
 * Immutable snapshot of the adapter's identity at the moment of invocation. Stored on the
 * agent_runs row so that re-registering or deactivating an adapter does not alter the provenance
 * record of historical runs (docs/03 §6).
 */
export interface AdapterRunSnapshot {
  readonly name: string;
  readonly implementation: string;
  readonly version: number;
  readonly capabilitiesUsed: readonly string[];
}

export interface RecordRunOptions {
  readonly adapterId: string;
  readonly role: string;
  readonly projectId?: string;
  readonly featureRunId?: string;
  readonly input: unknown;
  /**
   * Which capabilities the run exercised. The recorder snapshots name/implementation/version
   * from the registry automatically; only the exercised-capabilities list is caller-supplied
   * since the recorder cannot observe which subset was used during a run.
   */
  readonly capabilitiesUsed?: readonly string[];
}

export interface RecordRunResult<O> {
  readonly agentRunId: string;
  readonly output: O;
}

const validator = new StateTransitionValidator(AGENT_RUN_MATRIX, 'agent-run');

/**
 * Wraps an adapter invocation with persistence-backed `agent_runs` lifecycle recording
 * (queued -> running -> succeeded|failed), driven through the agent-run state matrix delivered
 * in Phase 2. Adapter provenance (name/implementation/version) is resolved automatically from
 * the injected registry at invocation time, so re-registration cannot alter historical records.
 * Private chain-of-thought must never be passed as `input`/output here — only structured I/O.
 */
export class AgentRunRecorder {
  constructor(
    private readonly db: DbClient,
    private readonly registry: AdapterRegistry,
    private readonly redactor: SecretRedactor = defaultRedactor,
  ) {}

  async record<O>(opts: RecordRunOptions, fn: () => Promise<O>): Promise<RecordRunResult<O>> {
    const agentRunId = generateId();
    const queuedAt = isoNow();

    // Snapshot adapter identity from the registry at invocation time. getById throws
    // UnknownAdapterError for an invalid adapterId, which is correct — recording a run
    // against an unknown adapter is a caller error.
    const adapterRecord = await this.registry.getById(opts.adapterId);
    const snap: AdapterRunSnapshot = {
      name: adapterRecord.name,
      implementation: adapterRecord.implementation,
      version: adapterRecord.version,
      capabilitiesUsed: opts.capabilitiesUsed ?? [],
    };

    await this.db.execute(
      `INSERT INTO agent_runs
         (id, adapter_id, project_id, feature_run_id, role, state, input_summary,
          adapter_name, adapter_implementation, adapter_version, capabilities_used,
          version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        agentRunId,
        opts.adapterId,
        opts.projectId ?? null,
        opts.featureRunId ?? null,
        opts.role,
        AgentRunState.QUEUED,
        JSON.stringify(this.redactor.redactObject(opts.input)),
        snap.name,
        snap.implementation,
        snap.version,
        JSON.stringify(snap.capabilitiesUsed),
        queuedAt,
        queuedAt,
      ],
    );

    validator.assertValid(AgentRunState.QUEUED, AgentRunState.RUNNING);
    const startedAt = isoNow();
    await this.db.execute(
      `UPDATE agent_runs SET state = ?, started_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      [AgentRunState.RUNNING, startedAt, startedAt, agentRunId],
    );

    try {
      const output = await fn();

      validator.assertValid(AgentRunState.RUNNING, AgentRunState.SUCCEEDED);
      const endedAt = isoNow();
      await this.db.execute(
        `UPDATE agent_runs SET state = ?, output_summary = ?, ended_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        [
          AgentRunState.SUCCEEDED,
          JSON.stringify(this.redactor.redactObject(output)),
          endedAt,
          endedAt,
          agentRunId,
        ],
      );

      return { agentRunId, output };
    } catch (err) {
      const errorType: AgentRunErrorType =
        err instanceof AdapterRunError ? err.errorType : 'provider_unavailable';
      const message = this.redactor.redact(err instanceof Error ? err.message : String(err));

      validator.assertValid(AgentRunState.RUNNING, AgentRunState.FAILED);
      const endedAt = isoNow();
      await this.db.execute(
        `UPDATE agent_runs SET state = ?, error = ?, ended_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        [AgentRunState.FAILED, message, endedAt, endedAt, agentRunId],
      );
      await this.db.execute(
        `INSERT INTO agent_errors (id, agent_run_id, error_type, message, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [generateId(), agentRunId, errorType, message, endedAt, endedAt],
      );

      throw err;
    }
  }
}
