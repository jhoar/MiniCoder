-- Issue #46: the clean-review path (no blocking/requires_human_decision findings, so no state
-- transition to atomically piggyback the review_findings write on) had no way to detect "this
-- exact review occurrence was already fully recorded" on a crash/retry -- a retry would
-- re-invoke the reviewer adapter and recompute reviewCycle = MAX(review_cycle) + 1, duplicating
-- audit-only findings and wasting a reviewer-adapter cost.
--
-- review_occurrence_markers is a deterministic, idempotent ledger keyed by (feature_run_id,
-- head_sha) -- the PR's head commit already uniquely identifies "which diff was reviewed" without
-- a running MAX() count. Checked BEFORE invoking the reviewer adapter: if a marker already exists
-- for the current head_sha, the prior recorded outcome is returned directly and the adapter is
-- never re-invoked.
CREATE TABLE review_occurrence_markers (
  id             TEXT    PRIMARY KEY,
  feature_run_id TEXT    NOT NULL REFERENCES feature_runs(id) ON DELETE CASCADE,
  head_sha       TEXT    NOT NULL,
  review_cycle   INTEGER NOT NULL,
  outcome        TEXT    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(feature_run_id, head_sha)
);

CREATE INDEX idx_review_occurrence_markers_feature_run_id ON review_occurrence_markers(feature_run_id);
