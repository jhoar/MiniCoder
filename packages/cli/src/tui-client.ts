/**
 * Shared HTTP-client plumbing for the Ink Text UI commands (Phase 14, docs/05 §4). These commands
 * are the first CLI code in this repo to call `@minicoder/api` over HTTP rather than importing it
 * in-process against the DB — the TUI must go through the Orchestrator API only (docs/05 §1/§10).
 */
import { randomUUID } from 'crypto';
import type React from 'react';
import { ApiClient, resolveApiConfig, runView, ApiError } from '@minicoder/tui';

export function buildApiClient(): ApiClient {
  return new ApiClient(resolveApiConfig());
}

export interface JsonOption {
  json?: boolean;
}

export interface IdempotencyKeyOption {
  idempotencyKey?: string;
}

/**
 * Every write/enqueue command mints a fresh `Idempotency-Key` by default (a repeated invocation
 * is a new, distinct submission — the same reasoning `pause.ts`/`resume.ts` already document).
 * `--idempotency-key <key>` lets an operator supply their own, so a command that times out or
 * whose response is lost can be safely retried with the *same* key instead of risking a duplicate
 * side effect (code-review fix — MEDIUM-2).
 */
export function resolveIdempotencyKey(prefix: string, opts: IdempotencyKeyOption): string {
  return opts.idempotencyKey ?? `${prefix}:${randomUUID()}`;
}

/**
 * Fetches data and either prints it as raw JSON (`--json`, for scripting — parity with every
 * other command group's JSON-envelope convention) or renders it through Ink via `runView()`. The
 * non-JSON path's error handling is entirely `runView()`'s own (colorized `ErrorView` + non-zero
 * exit); the JSON path handles errors separately since there is no Ink tree to render into.
 */
export async function renderOrJson<T>(
  opts: JsonOption,
  fetchData: () => Promise<T>,
  toView: (data: T) => React.ReactElement,
): Promise<void> {
  if (opts.json) {
    try {
      console.log(JSON.stringify(await fetchData(), null, 2));
    } catch (err) {
      if (err instanceof ApiError) {
        console.error(JSON.stringify(err.problem, null, 2));
      } else {
        console.error(err instanceof Error ? err.message : String(err));
      }
      process.exitCode = 1;
    }
    return;
  }
  await runView(async () => toView(await fetchData()));
}
