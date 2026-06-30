import type { DbClient } from '../persistence/types.js';
import { generateId, isoNow } from '../commands/helpers.js';
import type { AgentCapabilityToken } from './capabilities.js';
import { validateCapabilities } from './capabilities.js';

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

function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // SQLite: "UNIQUE constraint failed: agent_adapters.role, agent_adapters.name"
  if (err.message.includes('UNIQUE constraint failed')) return true;
  // PostgreSQL driver: error code 23505
  if ((err as { code?: string }).code === '23505') return true;
  return false;
}

/**
 * Database-backed resolution of "which adapter implementation handles role X" plus its
 * declared capabilities and resolved configuration (docs/03 §7: adapter configuration is
 * database-backed against agent_adapters/agent_configurations).
 */
export class AdapterRegistry {
  constructor(private readonly db: DbClient) {}

  /**
   * Idempotent upsert keyed on (role, name): re-registering replaces capabilities.
   * Safe under concurrent callers — unique-constraint violations are caught and resolved
   * by re-reading the winning row and falling through to the UPDATE path.
   */
  async register(input: RegisterAdapterInput): Promise<string> {
    return this.db.transaction(async (tx) => {
      const now = isoNow();
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM agent_adapters WHERE role = ? AND name = ?`,
        [input.role, input.name],
      );

      let adapterId: string;
      let isNew: boolean;

      if (existing[0]) {
        adapterId = existing[0].id;
        isNew = false;
      } else {
        const newId = generateId();
        try {
          await tx.execute(
            `INSERT INTO agent_adapters (id, role, name, implementation, is_active, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
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
          adapterId = newId;
          isNew = true;
        } catch (err) {
          if (!isUniqueConstraintError(err)) throw err;
          // Concurrent registration won the INSERT race — re-read and fall through to UPDATE.
          const concurrent = await tx.query<{ id: string }>(
            `SELECT id FROM agent_adapters WHERE role = ? AND name = ?`,
            [input.role, input.name],
          );
          if (!concurrent[0]) throw err;
          adapterId = concurrent[0].id;
          isNew = false;
        }
      }

      if (!isNew) {
        await tx.execute(
          `UPDATE agent_adapters
           SET implementation = ?, is_active = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
          [input.implementation, (input.isActive ?? true) ? 1 : 0, now, adapterId],
        );
        await tx.execute(`DELETE FROM agent_capabilities WHERE adapter_id = ?`, [adapterId]);
      }

      for (const capability of input.capabilities) {
        await tx.execute(
          `INSERT INTO agent_capabilities (id, adapter_id, capability, version, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
          [generateId(), adapterId, capability, now, now],
        );
      }

      return adapterId;
    });
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
   * adapter's default (project_id IS NULL) row.
   */
  async getConfiguration(
    adapterId: string,
    projectId?: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.db.query<ConfigRow>(
      `SELECT config FROM agent_configurations
       WHERE adapter_id = ? AND (project_id = ? OR project_id IS NULL)
       ORDER BY project_id IS NULL ASC
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
    return {
      id: row.id,
      role: row.role,
      name: row.name,
      implementation: row.implementation,
      isActive: Boolean(row.is_active),
      version: row.version,
      capabilities: capabilityRows.map((c) => c.capability as AgentCapabilityToken),
    };
  }
}
