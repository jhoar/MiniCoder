-- Issue #46: see the SQLite migration's header comment for the full rationale.
CREATE TABLE review_occurrence_markers (
  id             TEXT        PRIMARY KEY,
  feature_run_id TEXT        NOT NULL REFERENCES feature_runs(id) ON DELETE CASCADE,
  head_sha       TEXT        NOT NULL,
  review_cycle   INTEGER     NOT NULL,
  outcome        TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(feature_run_id, head_sha)
);

CREATE INDEX idx_review_occurrence_markers_feature_run_id ON review_occurrence_markers(feature_run_id);
