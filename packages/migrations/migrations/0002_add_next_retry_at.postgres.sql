-- Migration 0002: add next_retry_at column to outbox_events and inbox_events
-- for deterministic backoff scheduling in the outbox/inbox dispatcher.

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE inbox_events ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_outbox_events_next_retry_at ON outbox_events(next_retry_at);
CREATE INDEX IF NOT EXISTS idx_inbox_events_next_retry_at ON inbox_events(next_retry_at);
