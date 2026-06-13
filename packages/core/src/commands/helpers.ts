import type { TxClient } from '../persistence/types.js';
import { StaleFenceError } from '../persistence/types.js';
import type { CommandResult } from './types.js';
import { SCHEMA_VERSION } from '../events/schemas.js';
import { defaultRedactor } from '../auth/redaction.js';

export function parseJsonField<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export async function readIdempotencyFromTx<S extends string>(
  tx: TxClient,
  key: string,
  scope: string,
): Promise<CommandResult<S> | null> {
  const rows = await tx.query<{ result: string }>(
    `SELECT result FROM idempotency_keys WHERE key = ? AND scope = ? AND expires_at > ?`,
    [key, scope, isoNow()],
  );
  if (rows.length > 0 && rows[0]) {
    return parseJsonField<CommandResult<S>>(rows[0].result);
  }
  return null;
}

export function ttlIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

export async function writeIdempotencyKey(
  tx: TxClient,
  opts: {
    key: string;
    scope: string;
    result: CommandResult;
    ttlMs: number;
  },
): Promise<void> {
  const id = generateId();
  const now = isoNow();
  const expiresAt = ttlIso(opts.ttlMs);
  await tx.execute(
    `INSERT INTO idempotency_keys (id, key, scope, result, expires_at, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (key, scope) DO NOTHING`,
    [id, opts.key, opts.scope, JSON.stringify(opts.result), expiresAt, now, now],
  );
}

export async function assertLockFence(
  tx: TxClient,
  lockContext: { lockId: string; fence: number },
): Promise<void> {
  const now = isoNow();
  const rows = await tx.query<{ fence: number; expires_at: string | Date | null }>(
    `SELECT fence, expires_at FROM workflow_locks WHERE id = ?`,
    [lockContext.lockId],
  );
  const current = rows[0];
  const expiresAtStr = current?.expires_at instanceof Date
    ? current.expires_at.toISOString()
    : (current?.expires_at ?? null);
  if (!current || (expiresAtStr !== null && expiresAtStr < now)) {
    throw new StaleFenceError(lockContext.lockId, lockContext.fence, current?.fence ?? -1);
  }
  if (current.fence !== lockContext.fence) {
    throw new StaleFenceError(lockContext.lockId, lockContext.fence, current.fence);
  }
}
