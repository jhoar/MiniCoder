import type { DbClient } from '../persistence/types.js';
import { generateId, isoNow } from '../commands/helpers.js';
import { defaultRedactor, type SecretRedactor } from '../auth/redaction.js';
import { AgentRunState } from '../domain/states.js';
import { StateTransitionValidator } from '../statemachine/validator.js';
import { AGENT_RUN_MATRIX } from '../statemachine/machines/agent-run.js';
import type { AdapterRegistry } from './registry.js';

export class RunRoleMismatchError extends Error {
  constructor(
    public readonly adapterId: string,
    public readonly requestedRole: string,
    public readonly registeredRole: string,
  ) {
    super(
      `Adapter ${adapterId} is registered under role "${registeredRole}", but the run was ` +
        `requested for role "${requestedRole}"`,
    );
    this.name = 'RunRoleMismatchError';
  }
}

export class UndeclaredCapabilityError extends Error {
  constructor(
    public readonly adapterId: string,
    public readonly undeclared: readonly string[],
  ) {
    super(
      `Adapter ${adapterId} exercised capabilities not in its declared set: ${undeclared.join(', ')}`,
    );
    this.name = 'UndeclaredCapabilityError';
  }
}

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

/** Either branch of a completed run, passed to cost/tool-operation extractors (docs/01 §5.11 —
 * a failed provider call can still carry partial token/cost usage, so extractors see both
 * branches rather than only the success path). */
export type RunOutcome<O> =
  | { readonly ok: true; readonly output: O }
  | { readonly ok: false; readonly error: unknown };

/** Cost/token usage extracted from a run's outcome, folded into `agent_runs` and (when `costUsd`
 * is present) written as one `cost_records` row — Phase 9's first production writer of that
 * table (see CLAUDE.md's Reference Coder Adapter Operational Constraints). */
export interface RecordedCostUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly provider?: string;
  readonly model?: string;
}

/** One row of `agent_tool_operations` provenance (e.g. clone/install/test/push for a coder run). */
export interface RecordedToolOperation {
  readonly toolName: string;
  readonly inputSummary?: string;
  readonly outputSummary?: string;
  readonly status?: string;
  readonly durationMs?: number;
}

export interface RecordRunOptions<O = unknown> {
  readonly adapterId: string;
  /** Must match the adapter's registered role; a mismatch throws RunRoleMismatchError. */
  readonly role: string;
  readonly projectId?: string;
  readonly featureRunId?: string;
  /**
   * Required to attribute a written `cost_records` row to a budget-evaluable scope
   * (`evaluateBudget()` only sums rows with `scope='feature'`/`'project'` — see
   * `packages/core/src/cost/budget-evaluator.ts`). When `costExtractor` reports a `costUsd` and
   * this is set, the row is written with `scope='feature'`; otherwise `scope='project'`. Ignored
   * if `costExtractor` is not supplied or reports no `costUsd`.
   */
  readonly featureRequestId?: string;
  readonly promptTemplateVersion?: string;
  readonly input: unknown;
  /**
   * Which capabilities the run exercised. Required — silently defaulting to an empty list
   * would let a run that clearly used capabilities persist a misleading empty
   * `capabilities_used` record. Pass `[]` only for calls that genuinely exercise no declared
   * capability. Must be a subset of the adapter's declared capabilities (validated against the
   * registry); an undeclared capability throws UndeclaredCapabilityError. The recorder
   * snapshots name/implementation/version from the registry automatically; only the
   * exercised-capabilities subset is caller-supplied since the recorder cannot observe which
   * subset was used during a run.
   */
  readonly capabilitiesUsed: readonly string[];
  /**
   * The run's input context pack (docs/03 §11.4 — versioned, structured input). When present,
   * one `agent_context_packs` row is written before the wrapped call runs, keyed to the new
   * `agent_run_id` — Phase 9's first production writer of that table.
   */
  readonly contextPack?: { readonly content: unknown; readonly schemaVersion?: string };
  /**
   * Extracts cost/token usage from the run's outcome (success or failure). Invoked once after
   * `fn()` settles, before this method returns/rethrows — write-then-evaluate ordering, so a
   * caller's subsequent `evaluateBudget()` call sees this run's cost (docs/01 §5.11).
   */
  readonly costExtractor?: (outcome: RunOutcome<O>) => RecordedCostUsage | null | undefined;
  /** Extracts `agent_tool_operations` rows (e.g. clone/install/test/push) from the run's outcome. */
  readonly toolOperationsExtractor?: (
    outcome: RunOutcome<O>,
  ) => readonly RecordedToolOperation[] | null | undefined;
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
 * `role` and `capabilitiesUsed` are validated against the registry record — a role mismatch or
 * an undeclared capability throws rather than persisting a misleading provenance row.
 * `capabilitiesUsed` is a required argument (not defaulted) so callers must make an explicit
 * choice rather than silently producing an empty provenance record.
 * Private chain-of-thought must never be passed as `input`/output here — only structured I/O.
 */
export class AgentRunRecorder {
  constructor(
    private readonly db: DbClient,
    private readonly registry: AdapterRegistry,
    private readonly redactor: SecretRedactor = defaultRedactor,
  ) {}

  async record<O>(opts: RecordRunOptions<O>, fn: () => Promise<O>): Promise<RecordRunResult<O>> {
    const agentRunId = generateId();
    const queuedAt = isoNow();

    // Snapshot adapter identity from the registry at invocation time. getById throws
    // UnknownAdapterError for an invalid adapterId, which is correct — recording a run
    // against an unknown adapter is a caller error.
    const adapterRecord = await this.registry.getById(opts.adapterId);

    if (opts.role !== adapterRecord.role) {
      throw new RunRoleMismatchError(opts.adapterId, opts.role, adapterRecord.role);
    }

    const capabilitiesUsed = opts.capabilitiesUsed;
    const declared = new Set(adapterRecord.capabilities);
    const undeclared = capabilitiesUsed.filter((c) => !declared.has(c as never));
    if (undeclared.length > 0) {
      throw new UndeclaredCapabilityError(opts.adapterId, undeclared);
    }

    const snap: AdapterRunSnapshot = {
      name: adapterRecord.name,
      implementation: adapterRecord.implementation,
      version: adapterRecord.version,
      capabilitiesUsed,
    };

    await this.db.execute(
      `INSERT INTO agent_runs
         (id, adapter_id, project_id, feature_run_id, role, state, input_summary,
          adapter_name, adapter_implementation, adapter_version, capabilities_used,
          prompt_template_version, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        agentRunId,
        opts.adapterId,
        opts.projectId ?? null,
        opts.featureRunId ?? null,
        adapterRecord.role,
        AgentRunState.QUEUED,
        JSON.stringify(this.redactor.redactObject(opts.input)),
        snap.name,
        snap.implementation,
        snap.version,
        JSON.stringify(snap.capabilitiesUsed),
        opts.promptTemplateVersion ?? null,
        queuedAt,
        queuedAt,
      ],
    );

    if (opts.contextPack) {
      const packAt = isoNow();
      await this.db.execute(
        `INSERT INTO agent_context_packs
           (id, agent_run_id, content, content_schema_version, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [
          generateId(),
          agentRunId,
          JSON.stringify(this.redactor.redactObject(opts.contextPack.content)),
          opts.contextPack.schemaVersion ?? '1.0.0',
          packAt,
          packAt,
        ],
      );
    }

    validator.assertValid(AgentRunState.QUEUED, AgentRunState.RUNNING);
    const startedAt = isoNow();
    await this.db.execute(
      `UPDATE agent_runs SET state = ?, started_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      [AgentRunState.RUNNING, startedAt, startedAt, agentRunId],
    );

    try {
      const output = await fn();
      const outcome: RunOutcome<O> = { ok: true, output };

      validator.assertValid(AgentRunState.RUNNING, AgentRunState.SUCCEEDED);
      const endedAt = isoNow();
      const usage = opts.costExtractor?.(outcome) ?? null;
      await this.applyUsageAndSetSucceeded(agentRunId, output, usage, endedAt);
      if (usage) {
        await this.insertCostRecord(agentRunId, opts, usage, endedAt);
      }
      await this.insertToolOperations(agentRunId, opts.toolOperationsExtractor?.(outcome));

      return { agentRunId, output };
    } catch (err) {
      const errorType: AgentRunErrorType =
        err instanceof AdapterRunError ? err.errorType : 'provider_unavailable';
      const message = this.redactor.redact(err instanceof Error ? err.message : String(err));
      const outcome: RunOutcome<O> = { ok: false, error: err };

      validator.assertValid(AgentRunState.RUNNING, AgentRunState.FAILED);
      const endedAt = isoNow();
      const usage = opts.costExtractor?.(outcome) ?? null;
      await this.applyUsageAndSetFailed(agentRunId, message, usage, endedAt);
      if (usage) {
        await this.insertCostRecord(agentRunId, opts, usage, endedAt);
      }
      await this.insertToolOperations(agentRunId, opts.toolOperationsExtractor?.(outcome));
      await this.db.execute(
        `INSERT INTO agent_errors (id, agent_run_id, error_type, message, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [generateId(), agentRunId, errorType, message, endedAt, endedAt],
      );

      throw err;
    }
  }

  private totalTokens(usage: RecordedCostUsage | null): number | null {
    if (!usage) return null;
    if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null;
    return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }

  private async applyUsageAndSetSucceeded<O>(
    agentRunId: string,
    output: O,
    usage: RecordedCostUsage | null,
    endedAt: string,
  ): Promise<void> {
    await this.db.execute(
      `UPDATE agent_runs
         SET state = ?, output_summary = ?, ended_at = ?, tokens_used = COALESCE(?, tokens_used),
             cost_usd = COALESCE(?, cost_usd), provider = COALESCE(?, provider), model = COALESCE(?, model),
             version = version + 1, updated_at = ?
       WHERE id = ?`,
      [
        AgentRunState.SUCCEEDED,
        JSON.stringify(this.redactor.redactObject(output)),
        endedAt,
        this.totalTokens(usage),
        usage?.costUsd ?? null,
        usage?.provider ?? null,
        usage?.model ?? null,
        endedAt,
        agentRunId,
      ],
    );
  }

  private async applyUsageAndSetFailed(
    agentRunId: string,
    message: string,
    usage: RecordedCostUsage | null,
    endedAt: string,
  ): Promise<void> {
    await this.db.execute(
      `UPDATE agent_runs
         SET state = ?, error = ?, ended_at = ?, tokens_used = COALESCE(?, tokens_used),
             cost_usd = COALESCE(?, cost_usd), provider = COALESCE(?, provider), model = COALESCE(?, model),
             version = version + 1, updated_at = ?
       WHERE id = ?`,
      [
        AgentRunState.FAILED,
        message,
        endedAt,
        this.totalTokens(usage),
        usage?.costUsd ?? null,
        usage?.provider ?? null,
        usage?.model ?? null,
        endedAt,
        agentRunId,
      ],
    );
  }

  private async insertCostRecord<O>(
    agentRunId: string,
    opts: RecordRunOptions<O>,
    usage: RecordedCostUsage,
    recordedAt: string,
  ): Promise<void> {
    if (usage.costUsd === undefined) return;
    if (!opts.projectId) {
      throw new Error(
        'AgentRunRecorder.record: costExtractor reported costUsd but no projectId was supplied ' +
          '— cost_records.project_id is NOT NULL and cannot be attributed.',
      );
    }
    const scope = opts.featureRequestId ? 'feature' : 'project';
    await this.db.execute(
      `INSERT INTO cost_records
         (id, project_id, feature_request_id, feature_run_id, agent_run_id, scope, amount,
          provider, model, input_tokens, output_tokens, recorded_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        generateId(),
        opts.projectId,
        opts.featureRequestId ?? null,
        opts.featureRunId ?? null,
        agentRunId,
        scope,
        usage.costUsd,
        usage.provider ?? null,
        usage.model ?? null,
        usage.inputTokens ?? null,
        usage.outputTokens ?? null,
        recordedAt,
        recordedAt,
        recordedAt,
      ],
    );
  }

  private async insertToolOperations(
    agentRunId: string,
    operations: readonly RecordedToolOperation[] | null | undefined,
  ): Promise<void> {
    if (!operations || operations.length === 0) return;
    for (const op of operations) {
      const occurredAt = isoNow();
      await this.db.execute(
        `INSERT INTO agent_tool_operations
           (id, agent_run_id, tool_name, input_summary, output_summary, status, duration_ms, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          generateId(),
          agentRunId,
          op.toolName,
          op.inputSummary ?? null,
          op.outputSummary ?? null,
          op.status ?? 'success',
          op.durationMs ?? null,
          occurredAt,
          occurredAt,
        ],
      );
    }
  }
}
