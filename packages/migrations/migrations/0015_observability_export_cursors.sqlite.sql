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
CREATE TABLE observability_export_cursors (
  id             TEXT PRIMARY KEY,
  last_event_id  TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
