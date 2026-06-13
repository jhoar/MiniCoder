import type { DbClient } from '../persistence/types.js';
import type { CommandEnvelope, CommandHandler, CommandResult } from './types.js';
import { assertRole } from '../auth/guards.js';

interface IdempotencyRow {
  result: string;
}

function isoNow(): string {
  return new Date().toISOString();
}

function ttlIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/**
 * TransactionalCommandExecutor implements the 5-step idempotent command pattern:
 * 1. Check idempotency key (plain read, outside transaction — optimization only)
 * 2-5. Delegate to handler which runs within db.transaction()
 *
 * Handlers own steps 2-5: load entity, validate transition, UPDATE entity state
 * (with executeAffected verification for CAS), write workflow_event + outbox_event
 * + idempotency_keys. The outer check is an optimization; the inner INSERT ON
 * CONFLICT DO NOTHING provides the authoritative idempotency guarantee.
 */
export class TransactionalCommandExecutor {
  constructor(
    private readonly db: DbClient,
    private readonly idempotencyTtlMs: number = 7 * 24 * 60 * 60 * 1000,
  ) {}

  async execute<P, S extends string>(
    handler: CommandHandler<P, S>,
    envelope: CommandEnvelope<P>,
  ): Promise<CommandResult<S>> {
    assertRole(envelope.actor, handler.requiredRole, handler.commandName);

    const cached = await this.checkIdempotencyKey(
      envelope.idempotencyKey,
      handler.idempotencyScope,
    );
    if (cached !== null) {
      return cached as CommandResult<S>;
    }

    return handler.execute(envelope, this.db);
  }

  private async checkIdempotencyKey(key: string, scope: string): Promise<CommandResult | null> {
    const rows = await this.db.query<IdempotencyRow>(
      `SELECT result FROM idempotency_keys WHERE key = ? AND scope = ? AND expires_at > ?`,
      [key, scope, isoNow()],
    );
    if (rows.length > 0 && rows[0]) {
      return JSON.parse(rows[0].result) as CommandResult;
    }
    return null;
  }
}

export function makeIdempotencyKeyRecord(
  id: string,
  key: string,
  scope: string,
  result: CommandResult,
  ttlMs: number,
): readonly [string, string, string, string, string, number, string, string] {
  const now = isoNow();
  const expiresAt = ttlIso(ttlMs);
  return [id, key, scope, JSON.stringify(result), expiresAt, 1, now, now];
}
