import type { TxClient } from '../persistence/types.js';
import { StaleFenceError } from '../persistence/types.js';
import type { CommandResult } from './types.js';
import { CommandError } from './types.js';
import { SCHEMA_VERSION } from '../events/schemas.js';
import { defaultRedactor } from '../auth/redaction.js';

export function parseJsonField<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function ttlIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Claim-first idempotency: INSERT a NULL-result sentinel at the start of the transaction.
 * Only one concurrent transaction can claim the slot; others either get the cached result
 * (if the winner committed) or a 409 (if it is still in progress).
 */
export async function claimIdempotencyKey<S extends string>(
  tx: TxClient,
  key: string,
  scope: string,
  ttlMs: number,
): Promise<{ owned: true; claimId: string } | { owned: false; result: CommandResult<S> }> {
  const claimId = generateId();
  const now = isoNow();
  const expiresAt = ttlIso(ttlMs);

  // Remove any expired row first so the slot can be legitimately reused
  await tx.execute(`DELETE FROM idempotency_keys WHERE key = ? AND scope = ? AND expires_at <= ?`, [
    key,
    scope,
    now,
  ]);

  const inserted = await tx.executeAffected(
    `INSERT INTO idempotency_keys (id, key, scope, result, expires_at, version, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 1, ?, ?)
     ON CONFLICT (key, scope) DO NOTHING`,
    [claimId, key, scope, expiresAt, now, now],
  );

  if (inserted === 1) {
    return { owned: true, claimId };
  }

  // Conflict with a live (non-expired) row
  const rows = await tx.query<{ id: string; result: string | null }>(
    `SELECT id, result FROM idempotency_keys WHERE key = ? AND scope = ? AND expires_at > ?`,
    [key, scope, now],
  );
  const existing = rows[0];
  if (existing?.result !== null && existing?.result !== undefined) {
    return { owned: false, result: parseJsonField<CommandResult<S>>(existing.result) };
  }
  // Another transaction is in-progress with the same key
  throw new CommandError({
    type: 'concurrent-command',
    title: 'Concurrent command in progress',
    status: 409,
    detail: `A concurrent request with idempotency key "${key}" is already in progress`,
  });
}

/** Write the final result into the claimed idempotency slot. */
export async function fulfillIdempotencyKey(
  tx: TxClient,
  claimId: string,
  result: CommandResult,
): Promise<void> {
  await tx.execute(
    `UPDATE idempotency_keys SET result = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    [JSON.stringify(result), isoNow(), claimId],
  );
}

export async function writeWorkflowEvent(
  tx: TxClient,
  opts: {
    featureRunId?: string;
    projectId?: string;
    eventType: string;
    fromState: string;
    toState: string;
    actorId: string;
    correlationId: string;
  },
): Promise<string> {
  const id = generateId();
  const now = isoNow();
  // Schema columns: actor (not actor_id); no correlation_id column in workflow_events
  await tx.execute(
    `INSERT INTO workflow_events (id, feature_run_id, project_id, event_type, from_state, to_state, actor, payload_schema_version, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.featureRunId ?? null,
      opts.projectId ?? null,
      opts.eventType,
      opts.fromState,
      opts.toState,
      opts.actorId,
      SCHEMA_VERSION,
      now,
      now,
    ],
  );
  return id;
}

export async function writeOutboxEvent(
  tx: TxClient,
  opts: {
    eventType: string;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const id = generateId();
  const now = isoNow();
  const safePayload = defaultRedactor.redactObject(opts.payload);
  await tx.execute(
    `INSERT INTO outbox_events (id, event_type, payload, payload_schema_version, status, attempts, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, 1, ?, ?)`,
    [id, opts.eventType, JSON.stringify(safePayload), SCHEMA_VERSION, now, now],
  );
  return id;
}

export async function assertLockFence(
  tx: TxClient,
  lockContext: {
    lockId: string;
    fence: number;
    holderId: string;
    projectId?: string;
    resourceKey?: string;
  },
): Promise<void> {
  const now = isoNow();
  const rows = await tx.query<{
    fence: number;
    expires_at: string | Date | null;
    holder_id: string;
    project_id: string;
    resource_key: string;
  }>(
    `SELECT fence, expires_at, holder_id, project_id, resource_key FROM workflow_locks WHERE id = ?`,
    [lockContext.lockId],
  );
  const current = rows[0];
  const expiresAtStr =
    current?.expires_at instanceof Date
      ? current.expires_at.toISOString()
      : (current?.expires_at ?? null);
  if (!current || (expiresAtStr !== null && expiresAtStr < now)) {
    throw new StaleFenceError(lockContext.lockId, lockContext.fence, current?.fence ?? -1);
  }
  if (current.fence !== lockContext.fence) {
    throw new StaleFenceError(lockContext.lockId, lockContext.fence, current.fence);
  }
  if (current.holder_id !== lockContext.holderId) {
    throw new StaleFenceError(lockContext.lockId, lockContext.fence, current.fence);
  }
  if (lockContext.projectId !== undefined && current.project_id !== lockContext.projectId) {
    throw new StaleFenceError(lockContext.lockId, lockContext.fence, current.fence);
  }
  if (lockContext.resourceKey !== undefined && current.resource_key !== lockContext.resourceKey) {
    throw new StaleFenceError(lockContext.lockId, lockContext.fence, current.fence);
  }
}
