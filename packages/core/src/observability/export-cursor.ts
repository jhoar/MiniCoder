/**
 * Durable cursor for `exportWorkflowEventsToOtlp()` (issue #67). `exportWorkflowEventsToOtlp()`
 * itself is a pure, caller-parameterized function (`sinceEventId` in, `lastEventId` out) with no
 * persistence of its own — a one-shot CLI invocation (`minicoder observability export-otel`, the
 * design decided on issue #67 specifically to avoid an always-on Trigger.dev/network dependency)
 * has no in-memory state across invocations, so the cursor must live in the database instead.
 *
 * `observability_export_cursors` (migration 0015) is a single-row-per-export-target table, not a
 * column bolted onto an existing table — this cursor tracks an export target, not a domain
 * entity. Upserts via `ON CONFLICT ... DO UPDATE`, the same safe idempotent-write shape
 * `writeDesignDocumentSections()` already establishes (never the `DO NOTHING`-then-requery
 * anti-pattern `AdapterRegistry.register()`'s doc comment warns against).
 */
import { isoNow } from '../commands/helpers.js';
import type { DbClient, TxClient } from '../persistence/types.js';

export interface ObservabilityExportCursorRow {
  id: string;
  last_event_id: string | null;
  updated_at: string;
}

export async function getObservabilityExportCursor(
  db: DbClient | TxClient,
  cursorId: string,
): Promise<string | null> {
  const rows = await db.query<ObservabilityExportCursorRow>(
    `SELECT id, last_event_id, updated_at FROM observability_export_cursors WHERE id = ?`,
    [cursorId],
  );
  return rows[0]?.last_event_id ?? null;
}

export async function setObservabilityExportCursor(
  db: DbClient | TxClient,
  cursorId: string,
  lastEventId: string,
): Promise<void> {
  await db.execute(
    `INSERT INTO observability_export_cursors (id, last_event_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (id)
     DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = excluded.updated_at`,
    [cursorId, lastEventId, isoNow()],
  );
}
