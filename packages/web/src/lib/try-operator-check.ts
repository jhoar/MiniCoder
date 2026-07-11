import { ApiError } from './api-client';

export type CheckResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'forbidden' }
  | { kind: 'error'; detail: string };

/** `doctor`/`validate` require `operator`+ (backend-enforced). A `viewer`-role key gets a 403 —
 * caught here and rendered as an omitted section, mirroring `packages/tui`'s own established
 * "the API enforces authorization, the UI never duplicates the check, just degrades gracefully"
 * convention (see CLAUDE.md's Ink Text UI section and this package's own operational constraints).
 * Any *other* failure (5xx, network, malformed response) must render as a distinct error state,
 * not the same "no access" message — collapsing them made a real backend outage indistinguishable
 * from an intentional permission restriction (caught in PR review). Lives in `lib/` (not inline in
 * `state-health/page.tsx`) specifically so it stays importable from a plain Vitest unit test —
 * this file has no `server-only` import, unlike `api-server.ts`. */
export async function tryOperatorCheck<T>(fn: () => Promise<T>): Promise<CheckResult<T>> {
  try {
    return { kind: 'ok', data: await fn() };
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) return { kind: 'forbidden' };
    return { kind: 'error', detail: err instanceof Error ? err.message : 'Unknown error' };
  }
}
