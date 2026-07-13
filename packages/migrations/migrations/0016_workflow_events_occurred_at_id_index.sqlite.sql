-- PR #73 review fix (round 3, LOW-1): exportWorkflowEventsToOtlp()'s composite (occurred_at, id)
-- keyset cursor (migration 0015's round-2 fix) filters and orders by `occurred_at ASC, id ASC`,
-- but the only existing index on this table covers `occurred_at` alone
-- (idx_workflow_events_occurred_at, migration 0001). Fine at small scale, but an avoidable
-- scan/sort as workflow_events grows. This composite index does not replace the single-column
-- one -- other callers (e.g. `state doctor`, timeline reads) still query by occurred_at alone
-- and benefit from either index equally; this one is specifically for the (occurred_at, id)
-- keyset-pagination access pattern.
CREATE INDEX idx_workflow_events_occurred_at_id ON workflow_events(occurred_at, id);
