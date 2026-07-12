/**
 * Durable cursor for `exportWorkflowEventsToOtlp()` (issue #67). `exportWorkflowEventsToOtlp()`
 * itself is a pure, caller-parameterized function (`sinceEventId`/`sinceOccurredAt` in,
 * `lastEventId`/`lastOccurredAt` out) with no persistence of its own — a one-shot CLI invocation
 * (`minicoder observability export-otel`, the design decided on issue #67 specifically to avoid
 * an always-on Trigger.dev/network dependency) has no in-memory state across invocations, so the
 * cursor must live in the database instead.
 *
 * `observability_export_cursors` (migration 0015) is a single-row-per-export-target table, not a
 * column bolted onto an existing table — this cursor tracks an export target, not a domain
 * entity. Upserts via `ON CONFLICT ... DO UPDATE`, the same safe idempotent-write shape
 * `writeDesignDocumentSections()` already establishes (never the `DO NOTHING`-then-requery
 * anti-pattern `AdapterRegistry.register()`'s doc comment warns against).
 *
 * PR #73 review fix (round 2, MEDIUM-2): the cursor is a **composite** `(last_occurred_at,
 * last_event_id)` pair, not `last_event_id` alone. `workflow_events.id` is usually `generateId()`'s
 * time-sortable `${Date.now()}-${random}` shape, but `state repair --apply` inserts a
 * `workflow_events` row keyed by `crypto.randomUUID()` instead — a different id scheme with no
 * consistent lexical ordering relative to `generateId()`'s. A `last_event_id`-only cursor could
 * therefore permanently skip a later, ordinary event once a UUID-keyed row became the cursor. The
 * composite pair gives `exportWorkflowEventsToOtlp()` a real, id-scheme-independent keyset cursor:
 * resume from `occurred_at > last_occurred_at OR (occurred_at = last_occurred_at AND id >
 * last_event_id)`. `last_event_id` is kept (not just `last_occurred_at`) purely as the tiebreaker
 * for same-timestamp rows — occurred_at alone is not unique.
 */
import { isoNow } from '../commands/helpers.js';
import type { DbClient, TxClient } from '../persistence/types.js';

export interface ObservabilityExportCursorRow {
  id: string;
  last_event_id: string | null;
  last_occurred_at: string | null;
  updated_at: string;
}

export interface ObservabilityExportCursor {
  lastEventId: string;
  lastOccurredAt: string;
}

export async function getObservabilityExportCursor(
  db: DbClient | TxClient,
  cursorId: string,
): Promise<ObservabilityExportCursor | null> {
  const rows = await db.query<ObservabilityExportCursorRow>(
    `SELECT id, last_event_id, last_occurred_at, updated_at FROM observability_export_cursors WHERE id = ?`,
    [cursorId],
  );
  const row = rows[0];
  if (!row?.last_event_id || !row.last_occurred_at) return null;
  return { lastEventId: row.last_event_id, lastOccurredAt: row.last_occurred_at };
}

export async function setObservabilityExportCursor(
  db: DbClient | TxClient,
  cursorId: string,
  cursor: ObservabilityExportCursor,
): Promise<void> {
  await db.execute(
    `INSERT INTO observability_export_cursors (id, last_event_id, last_occurred_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (id)
     DO UPDATE SET last_event_id = excluded.last_event_id, last_occurred_at = excluded.last_occurred_at, updated_at = excluded.updated_at`,
    [cursorId, cursor.lastEventId, cursor.lastOccurredAt, isoNow()],
  );
}
