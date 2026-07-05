/**
 * Claim-first HTTP route idempotency — the same "reserve a NULL row, then fulfill it" pattern
 * `packages/core/src/commands/helpers.ts`'s `claimIdempotencyKey`/`fulfillIdempotencyKey` already
 * use for command dispatch, applied at the route level for routes that span a real external side
 * effect (a GitHub API call, a lock/queue mutation) and so cannot be made idempotent by a single
 * `CommandHandler`'s own transaction.
 *
 * A post-hoc "check cache, do work, store result" approach is NOT concurrency-safe: two concurrent
 * requests with the same `Idempotency-Key` can both miss the cache and both perform the side
 * effect before either response is stored. Claiming the `(key, scope)` row via `INSERT ... ON
 * CONFLICT DO NOTHING` first closes that race — the UNIQUE constraint, not application logic, is
 * what serializes concurrent claims, exactly as it does for command dispatch.
 */
import { generateId, isoNow, ttlIso, type DbClient } from '@minicoder/core';

export interface RouteResponse {
  status: number;
  body: unknown;
}

export type ClaimResult =
  | { outcome: 'owned'; claimId: string }
  | { outcome: 'fulfilled'; response: RouteResponse }
  | { outcome: 'in-progress' };

/**
 * Attempts to claim `(key, scope)`. Returns `owned` if this call is the first/only claimant (the
 * caller must now do the work and call `fulfillRouteIdempotencyKey`); `fulfilled` if a prior
 * claimant already completed and cached a response (replay it verbatim, no work to redo);
 * `in-progress` if another request currently holds the claim and hasn't finished yet (the caller
 * should return a retryable 409, not perform the side effect a second time).
 */
export async function claimRouteIdempotencyKey(
  db: DbClient,
  key: string,
  scope: string,
  ttlMs: number,
): Promise<ClaimResult> {
  const claimId = generateId();
  const now = isoNow();
  const expiresAt = ttlIso(ttlMs);

  // Remove any expired row first so the slot can be legitimately reused.
  await db.execute(`DELETE FROM idempotency_keys WHERE key = ? AND scope = ? AND expires_at <= ?`, [
    key,
    scope,
    now,
  ]);

  const inserted = await db.executeAffected(
    `INSERT INTO idempotency_keys (id, key, scope, result, expires_at, version, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 1, ?, ?)
     ON CONFLICT (key, scope) DO NOTHING`,
    [claimId, key, scope, expiresAt, now, now],
  );
  if (inserted === 1) {
    return { outcome: 'owned', claimId };
  }

  const rows = await db.query<{ result: string | null }>(
    `SELECT result FROM idempotency_keys WHERE key = ? AND scope = ? AND expires_at > ?`,
    [key, scope, now],
  );
  const row = rows[0];
  if (row?.result) {
    return { outcome: 'fulfilled', response: JSON.parse(row.result) as RouteResponse };
  }
  return { outcome: 'in-progress' };
}

export async function fulfillRouteIdempotencyKey(
  db: DbClient,
  claimId: string,
  response: RouteResponse,
): Promise<void> {
  await db.execute(
    `UPDATE idempotency_keys SET result = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    [JSON.stringify(response), isoNow(), claimId],
  );
}

/**
 * Releases an owned claim without fulfilling it — used when the claiming request throws before
 * producing a cacheable response (a pre-check failure, an infra error). Without this, a claim row
 * left with `result = NULL` would make every retry see `in-progress` until the TTL expires days
 * later, even after whatever caused the original failure has been fixed.
 */
export async function releaseRouteIdempotencyKey(db: DbClient, claimId: string): Promise<void> {
  await db.execute(`DELETE FROM idempotency_keys WHERE id = ?`, [claimId]);
}
