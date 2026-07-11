import 'server-only';
import { ApiError } from './api-client';

/** Discriminated result every Server Action in this package returns — Next.js serializes a
 * thrown error across the Server Action boundary into an opaque digest in production, so a 403
 * or validation failure must come back as data, not an exception, for the UI to show the real
 * `detail` message (see CLAUDE.md's "Next.js Web UI Operational Constraints" section). */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'forbidden' | 'error'; detail: string };

export async function runCommandAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        kind: err.status === 403 ? 'forbidden' : 'error',
        detail: err.problem.detail || err.problem.title,
      };
    }
    return {
      ok: false,
      kind: 'error',
      detail: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/** Generates a fresh Idempotency-Key for one logical user submission — called inside the Server
 * Action body (the trust/generation boundary is the server, never browser JS). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
