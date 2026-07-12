/**
 * Optional OpenTelemetry-compatible export (Phase 16, docs/01 §5.12 Observability and Event
 * System). Fully opt-in, env-gated, and a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is
 * configured — never a required dependency for the rest of the system.
 *
 * Deliberately hand-rolled OTLP/HTTP JSON export via plain `fetch`, not the `@opentelemetry/*`
 * SDK: the current OTel JS SDK majors (`@opentelemetry/api`/`sdk-node`/`exporter-logs-otlp-http`)
 * ship ESM-only with no CommonJS export condition, the exact same wall this repo has hit
 * repeatedly with other vendor packages (GitHub's REST client, `ink`/`react`, `next`) — see
 * CLAUDE.md's documented "pin the last CJS-compatible major, or hand-roll a plain-fetch client"
 * pattern, e.g. `HttpReviewProvider`/`HttpCodeGenerationProvider`. `workflow_events` rows are
 * mapped to the OTLP Logs JSON payload
 * shape (`resourceLogs[].scopeLogs[].logRecords[]`) — the simplest OTLP signal that fits an
 * already-discrete, already-timestamped domain event, rather than trying to reconstruct spans
 * with parent/child relationships this schema does not track.
 *
 * `mapWorkflowEventsToOtlp()` is a pure function (no I/O) so it is unit-testable without a real
 * collector; `exportWorkflowEventsToOtlp()` is the thin I/O wrapper reading config and POSTing.
 * Both live in `packages/core` deliberately — this is not a provider SDK import (an OTLP
 * collector is an open, vendor-neutral wire format, not an LLM/DB provider the "provider-SDK-free
 * core" rule is aimed at), and env access goes through `ConfigBackend` (never bare
 * `process.env`), consistent with every other core config read.
 */
import type { DbClient } from '../persistence/types.js';
import type { ConfigBackend } from '../config/config.js';
import { EnvConfigBackend } from '../config/config.js';

export interface WorkflowEventRow {
  id: string;
  feature_run_id: string | null;
  project_id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  actor: string | null;
  occurred_at: string;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  severityText: 'INFO';
  body: { stringValue: string };
  attributes: Array<{ key: string; value: { stringValue: string } }>;
}

export interface OtlpLogsPayload {
  resourceLogs: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
    scopeLogs: Array<{
      scope: { name: string };
      logRecords: OtlpLogRecord[];
    }>;
  }>;
}

function toUnixNano(isoTimestamp: string): string {
  const ms = Date.parse(isoTimestamp);
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return `${BigInt(safeMs) * 1_000_000n}`;
}

function attr(key: string, value: string | null): { key: string; value: { stringValue: string } } {
  return { key, value: { stringValue: value ?? '' } };
}

/** Pure mapping — no I/O, no env access. Groups all rows into one `resourceLogs` entry (one
 * MiniCoder deployment = one OTel resource) with a single `minicoder.workflow-events` scope. */
export function mapWorkflowEventsToOtlp(events: WorkflowEventRow[]): OtlpLogsPayload {
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr('service.name', 'minicoder-orchestrator')] },
        scopeLogs: [
          {
            scope: { name: 'minicoder.workflow-events' },
            logRecords: events.map((event) => ({
              timeUnixNano: toUnixNano(event.occurred_at),
              severityText: 'INFO' as const,
              body: { stringValue: event.event_type },
              attributes: [
                attr('minicoder.event_id', event.id),
                attr('minicoder.project_id', event.project_id),
                attr('minicoder.feature_run_id', event.feature_run_id),
                attr('minicoder.from_state', event.from_state),
                attr('minicoder.to_state', event.to_state),
                attr('minicoder.actor', event.actor),
              ],
            })),
          },
        ],
      },
    ],
  };
}

export interface ExportWorkflowEventsOptions {
  /** Only export events with `id > sinceEventId` — a simple, per-call keyset cursor for a bounded
   * batch. Omit to export the oldest still-eligible batch unconditionally (see
   * `safetyMarginMs` below for why "oldest" is bounded, not "most recent"). */
  sinceEventId?: string;
  limit?: number;
  config?: ConfigBackend;
  fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds, applied via `AbortSignal.timeout()` — the same pattern
   * `HttpPlanProvider`/`HttpArbiterProvider` use for their outbound LLM calls. Without this, a
   * hung/unreachable collector could block a caller (e.g. a scheduled task) indefinitely.
   * Defaults to 30s. */
  timeoutMs?: number;
  /**
   * PR #73 review fix (MEDIUM-1): `id` is `generateId()`'s `${Date.now()}-${random}` shape, which
   * sorts chronologically close to insertion order but is **not** a safe commit-order cursor on
   * its own. Two concurrent transactions can generate ids A < B (A's `Date.now()` prefix earlier)
   * but commit in the opposite order (B commits first); if a caller's cursor advances to B before
   * A ever becomes visible, a plain `id > cursor` query would never return A once it does commit
   * — a silently dropped event. `safetyMarginMs` closes this: only events whose `occurred_at` is
   * at least this far in the past are eligible for export (or for advancing the cursor past), so
   * any transaction slower than the margin has had time to commit before its row's id range is
   * ever considered "settled." Defaults to 2 minutes — generous relative to a normal DB
   * transaction, tunable per deployment via this option. This does not eliminate the class of bug
   * entirely (a transaction slower than the margin could still be missed), but it converts an
   * unbounded race into one bounded by a caller-tunable, generous margin — the same "at-least-once
   * with a bounded staleness window" posture already accepted for this exporter (docs/01 §5.12).
   */
  safetyMarginMs?: number;
  /** Injectable clock for `safetyMarginMs` bound calculations — test seam only. */
  now?: () => Date;
}

export interface ExportWorkflowEventsResult {
  attempted: boolean;
  exportedCount: number;
  lastEventId: string | null;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SAFETY_MARGIN_MS = 2 * 60 * 1000;

/**
 * No-ops (`{attempted: false, exportedCount: 0, lastEventId: null}`) unless
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is configured — this function is always safe to call
 * unconditionally from a caller (e.g. a scheduled task) without its own env-check gate.
 */
export async function exportWorkflowEventsToOtlp(
  db: DbClient,
  opts: ExportWorkflowEventsOptions = {},
): Promise<ExportWorkflowEventsResult> {
  const config = opts.config ?? new EnvConfigBackend();
  const endpoint = config.get('OTEL_EXPORTER_OTLP_ENDPOINT');
  if (!endpoint || endpoint.trim().length === 0) {
    return { attempted: false, exportedCount: 0, lastEventId: null };
  }

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const safetyMarginMs = opts.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
  const now = opts.now ?? (() => new Date());
  const watermark = new Date(now().getTime() - safetyMarginMs).toISOString();

  const params: unknown[] = [];
  let sql = `SELECT id, feature_run_id, project_id, event_type, from_state, to_state, actor, occurred_at
             FROM workflow_events WHERE occurred_at <= ?`;
  params.push(watermark);
  if (opts.sinceEventId) {
    sql += ` AND id > ?`;
    params.push(opts.sinceEventId);
  }
  sql += ` ORDER BY id ASC LIMIT ?`;
  params.push(limit);

  const events = await db.query<WorkflowEventRow>(sql, params);
  if (events.length === 0) {
    return { attempted: true, exportedCount: 0, lastEventId: opts.sinceEventId ?? null };
  }

  const payload = mapWorkflowEventsToOtlp(events);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const logsUrl = endpoint.trim().replace(/\/+$/, '') + '/v1/logs';

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const response = await fetchImpl(logsUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`exportWorkflowEventsToOtlp: OTLP collector returned ${response.status}`);
  }

  return {
    attempted: true,
    exportedCount: events.length,
    lastEventId: events[events.length - 1]!.id,
  };
}
