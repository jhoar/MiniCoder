DROP INDEX IF EXISTS idx_outbox_events_next_retry_at;
DROP INDEX IF EXISTS idx_inbox_events_next_retry_at;
ALTER TABLE outbox_events DROP COLUMN IF EXISTS next_retry_at;
ALTER TABLE inbox_events DROP COLUMN IF EXISTS next_retry_at;
