-- Migration 0002: add next_retry_at column to outbox_events and inbox_events
-- for deterministic backoff scheduling in the outbox/inbox dispatcher.

ALTER TABLE outbox_events ADD COLUMN next_retry_at TEXT;
ALTER TABLE inbox_events ADD COLUMN next_retry_at TEXT;

CREATE INDEX idx_outbox_events_next_retry_at ON outbox_events(next_retry_at);
CREATE INDEX idx_inbox_events_next_retry_at ON inbox_events(next_retry_at);
