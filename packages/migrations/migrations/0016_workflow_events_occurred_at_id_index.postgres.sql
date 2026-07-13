-- PR #73 review fix (round 3, LOW-1): see the SQLite migration's header comment for the full
-- rationale.
CREATE INDEX idx_workflow_events_occurred_at_id ON workflow_events(occurred_at, id);
