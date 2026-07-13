-- Issue #67: exportWorkflowEventsToOtlp() (Phase 16) is a pure, cursor-parameterized function --
-- it accepts a caller-supplied sinceEventId but persists nothing itself. The decision recorded on
-- issue #67 is a one-shot CLI command (`minicoder observability export-otel`), invoked by a
-- deployment's own external scheduler (cron, k8s CronJob, etc.) rather than a new always-on
-- Trigger.dev task -- see CLAUDE.md's explicit "no always-on network dependency" instruction. A
-- one-shot CLI process has no in-memory state across invocations, so the cursor must be durable.
--
-- A single-row table (not a column bolted onto an existing table) because this cursor tracks an
-- export target, not a domain entity -- the same "small, dedicated table for a cursor" shape this
-- schema has no existing precedent for reusing. `id` is a fixed, caller-chosen export-target name
-- (e.g. 'workflow_events_otlp') rather than an auto-generated id, so a future second export target
-- (a different collector, a different event source) gets its own row without a schema change.
-- PR #73 review fix (round 2, MEDIUM-2): `last_event_id` alone is not a safe resume cursor.
-- `workflow_events.id` is usually `generateId()`'s time-sortable `${Date.now()}-${random}` shape,
-- but `state repair --apply` (packages/cli/src/commands/state.ts) inserts a `workflow_events` row
-- keyed by `crypto.randomUUID()` instead -- a different id scheme with no consistent lexical
-- ordering relative to the generateId() scheme. If a UUID-keyed row ever becomes the cursor, a
-- later ordinary event's id can compare lower even though it occurred after, and would be skipped
-- forever by a plain `id > cursor` resume query. `last_occurred_at` (paired with `last_event_id`
-- as a tiebreaker for same-timestamp rows) gives exportWorkflowEventsToOtlp() a real, dialect-
-- portable keyset-pagination cursor: `occurred_at > last_occurred_at OR (occurred_at =
-- last_occurred_at AND id > last_event_id)`.
--
-- PR #73 review round 3 (LOW-2, watched, not fixed): this column was added by editing migration
-- 0015 in place (adding `last_occurred_at` to the same CREATE TABLE) rather than as a new
-- migration -- deliberate, since this migration was still unmerged/pre-release at the time (see
-- CLAUDE.md's precedent for "editing an unmerged migration in place is safe; a merged one is
-- not"). Any environment that already applied an EARLIER revision of this exact migration file
-- (i.e. only pulled this branch mid-review, before this column existed) will not automatically
-- gain `last_occurred_at` -- `getObservabilityExportCursor()` treats a row missing it as "no
-- cursor" and the next `export-otel` run re-exports from the beginning (a one-time, harmless
-- re-export under this exporter's existing at-least-once contract, not data loss). This is
-- accepted as a pre-merge-only concern, not a real upgrade path: once this PR merges, migration
-- 0015 is fixed forever at this shape, and no deployment will ever have applied an earlier
-- revision of it.
CREATE TABLE observability_export_cursors (
  id                TEXT PRIMARY KEY,
  last_event_id     TEXT,
  last_occurred_at  TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
