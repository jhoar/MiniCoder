import type { DbClient } from '../persistence/types.js';
import { generateId, isoNow } from '../commands/helpers.js';
import type { AgentCapabilityToken } from './capabilities.js';
import { validateCapabilities, parseCapabilities } from './capabilities.js';

export interface AdapterRecord {
  readonly id: string;
  readonly role: string;
  readonly name: string;
  readonly implementation: string;
  readonly isActive: boolean;
  readonly version: number;
  readonly capabilities: readonly AgentCapabilityToken[];
}

export interface RegisterAdapterInput {
  readonly role: string;
  readonly name: string;
  readonly implementation: string;
  readonly capabilities: readonly AgentCapabilityToken[];
  readonly isActive?: boolean;
}

export class UnknownAdapterError extends Error {
  constructor(
    public readonly role: string,
    public readonly name: string,
  ) {
    super(`No registered adapter for role "${role}" named "${name}"`);
    this.name = 'UnknownAdapterError';
  }
}

interface AdapterRow {
  id: string;
  role: string;
  name: string;
  implementation: string;
  is_active: number | boolean;
  version: number;
}

interface CapabilityRow {
  capability: string;
}

interface ConfigRow {
  config: string;
}

/**
 * Database-backed resolution of "which adapter implementation handles role X" plus its
 * declared capabilities and resolved configuration (docs/03 §7: adapter configuration is
 * database-backed against agent_adapters/agent_configurations).
 */
export class AdapterRegistry {
  constructor(private readonly db: DbClient) {}

  /**
   * Idempotent upsert keyed on (role, name): re-registering replaces capabilities and
   * increments version. Safe under concurrent callers in both SQLite and PostgreSQL:
   * ON CONFLICT DO NOTHING avoids any error (and the PostgreSQL aborted-transaction problem),
   * then a re-select identifies the winning row so re-registrations fall through to UPDATE.
   */
  async register(input: RegisterAdapterInput): Promise<string> {
    // Validate and dedupe before touching the transaction — fail loudly on any capability
    // token that is not in AgentCapabilitySchema rather than persisting it as-is.
    const capabilities = parseCapabilities(
      input.capabilities,
      `register(${input.role}/${input.name}).capabilities`,
    );

    return this.db.transaction(async (tx) => {
      const now = isoNow();
      const newId = generateId();

      // ON CONFLICT DO NOTHING: never errors, so the transaction stays healthy in PostgreSQL
      // (catching 23505 inside an active transaction aborts it, making further queries fail).
      await tx.execute(
        `INSERT INTO agent_adapters (id, role, name, implementation, is_active, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (role, name) DO NOTHING`,
        [
          newId,
          input.role,
          input.name,
          input.implementation,
          (input.isActive ?? true) ? 1 : 0,
          now,
          now,
        ],
      );

      const rows = await tx.query<{ id: string }>(
        `SELECT id FROM agent_adapters WHERE role = ? AND name = ?`,
        [input.role, input.name],
      );
      if (!rows[0])
        throw new Error(`adapter insert produced no row for ${input.role}/${input.name}`);
      const adapterId = rows[0].id;

      if (adapterId !== newId) {
        // Pre-existing row (or concurrent winner) — update metadata and replace capabilities.
        await tx.execute(
          `UPDATE agent_adapters
           SET implementation = ?, is_active = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
          [input.implementation, (input.isActive ?? true) ? 1 : 0, now, adapterId],
        );
        await tx.execute(`DELETE FROM agent_capabilities WHERE adapter_id = ?`, [adapterId]);
      }

      for (const capability of capabilities) {
        await tx.execute(
          `INSERT INTO agent_capabilities (id, adapter_id, capability, version, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
          [generateId(), adapterId, capability, now, now],
        );
      }

      // Append-only audit provenance (issue #26): agent_adapters/agent_capabilities above are
      // mutable operational registry state — a later re-registration overwrites both, so a
      // historical agent_runs row cannot reconstruct "what capability set was declared at the
      // moment this run happened" by joining to the current agent_capabilities rows. Snapshot
      // the full declared capability set into adapter_revisions on every register() call (fresh
      // insert or version-bump update); AgentRunRecorder.record() looks this row up by
      // (adapter_id, version) and stamps agent_runs.adapter_revision_id with it.
      const versionRows = await tx.query<{ version: number }>(
        `SELECT version FROM agent_adapters WHERE id = ?`,
        [adapterId],
      );
      const currentVersion = versionRows[0]?.version ?? 1;
      await tx.execute(
        `INSERT INTO adapter_revisions
           (id, adapter_id, role, name, implementation, version, capabilities, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          generateId(),
          adapterId,
          input.role,
          input.name,
          input.implementation,
          currentVersion,
          JSON.stringify(capabilities),
          (input.isActive ?? true) ? 1 : 0,
          now,
        ],
      );

      return adapterId;
    });
  }

  /**
   * Looks up the immutable `adapter_revisions` row snapshotting an adapter's declared capability
   * set at a specific version — the audit-provenance counterpart to `getById()`'s current,
   * mutable registry state (issue #26). Returns `null` if no revision row exists for this
   * (adapter_id, version) pair (e.g. an adapter registered before this table existed). The
   * `created_at DESC, id DESC` ordering follows the same determinism convention as the
   * "latest conformance result" query (issue #27) in case more than one revision row somehow
   * shares a version.
   */
  async getRevisionId(adapterId: string, version: number): Promise<string | null> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM adapter_revisions
       WHERE adapter_id = ? AND version = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [adapterId, version],
    );
    return rows[0]?.id ?? null;
  }

  async resolve(role: string, name: string): Promise<AdapterRecord> {
    const rows = await this.db.query<AdapterRow>(
      `SELECT id, role, name, implementation, is_active, version FROM agent_adapters WHERE role = ? AND name = ?`,
      [role, name],
    );
    const row = rows.find((r) => Boolean(r.is_active));
    if (!row) {
      throw new UnknownAdapterError(role, name);
    }
    return this.toRecord(row);
  }

  async getById(adapterId: string): Promise<AdapterRecord> {
    const rows = await this.db.query<AdapterRow>(
      `SELECT id, role, name, implementation, is_active, version FROM agent_adapters WHERE id = ?`,
      [adapterId],
    );
    const row = rows.find((r) => Boolean(r.is_active));
    if (!row) {
      throw new UnknownAdapterError('unknown', adapterId);
    }
    return this.toRecord(row);
  }

  /** Retrieves an adapter record regardless of its active state (for audit/diagnostic use only). */
  async getByIdIncludingInactive(adapterId: string): Promise<AdapterRecord> {
    const rows = await this.db.query<AdapterRow>(
      `SELECT id, role, name, implementation, is_active, version FROM agent_adapters WHERE id = ?`,
      [adapterId],
    );
    const row = rows[0];
    if (!row) {
      throw new UnknownAdapterError('unknown', adapterId);
    }
    return this.toRecord(row);
  }

  /** Throws CapabilityError if the adapter is missing any capability in `required`. */
  async assertCapabilities(
    adapterId: string,
    required: readonly AgentCapabilityToken[],
  ): Promise<void> {
    const record = await this.getById(adapterId);
    validateCapabilities(adapterId, record.capabilities, required);
  }

  /**
   * Resolves the active configuration for an adapter, preferring a project-scoped row over the
   * adapter's default (project_id IS NULL) row. Migration 0006 enforces at most one default row
   * and at most one project-scoped row per (adapter, project) at the schema level; the
   * `version DESC, updated_at DESC` tiebreaker is defense-in-depth in case that invariant is
   * ever violated (e.g. a direct DB write bypassing the registry).
   */
  async getConfiguration(
    adapterId: string,
    projectId?: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.db.query<ConfigRow>(
      `SELECT config FROM agent_configurations
       WHERE adapter_id = ? AND (project_id = ? OR project_id IS NULL)
       ORDER BY project_id IS NULL ASC, version DESC, updated_at DESC
       LIMIT 1`,
      [adapterId, projectId ?? null],
    );
    const row = rows[0];
    if (!row) return null;
    return typeof row.config === 'string'
      ? (JSON.parse(row.config) as Record<string, unknown>)
      : (row.config as Record<string, unknown>);
  }

  private async toRecord(row: AdapterRow): Promise<AdapterRecord> {
    const capabilityRows = await this.db.query<CapabilityRow>(
      `SELECT capability FROM agent_capabilities WHERE adapter_id = ?`,
      [row.id],
    );
    // Fail loudly rather than casting a corrupted persisted row to AgentCapabilityToken —
    // a malformed capability string here would otherwise silently defeat assertCapabilities.
    const capabilities = parseCapabilities(
      capabilityRows.map((c) => c.capability),
      `agent_capabilities row(s) for adapter ${row.id}`,
    );
    return {
      id: row.id,
      role: row.role,
      name: row.name,
      implementation: row.implementation,
      isActive: Boolean(row.is_active),
      version: row.version,
      capabilities,
    };
  }
}
