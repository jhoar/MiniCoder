-- GitHub branch/PR/CI/review-state persistence (docs/01-system-specification.md §5.7, Phase 7).
--
-- pull_requests mirrors GitHub-observed state for a feature_run's pull request. review_state and
-- ci_status are observed mirrors of GitHub, overwritten directly on reconciliation -- unlike the
-- other canonical state machines, PR/review state has no StateTransitionValidator matrix (GitHub
-- remains authoritative; see docs/00-glossary-and-terms.md §3.10 PrReviewState). One row per
-- feature_run (a feature run has at most one open pull request at a time).

CREATE TABLE pull_requests (
  id                      TEXT        PRIMARY KEY,
  feature_run_id          TEXT        NOT NULL REFERENCES feature_runs(id) ON DELETE CASCADE,
  pr_number               INTEGER     NOT NULL,
  branch_name              TEXT        NOT NULL,
  base_branch               TEXT        NOT NULL,
  head_sha                  TEXT,
  state                     TEXT        NOT NULL DEFAULT 'open',
  review_state              TEXT        NOT NULL DEFAULT 'none',
  ci_status                 TEXT        NOT NULL DEFAULT 'pending',
  mergeable                 BOOLEAN,
  blocking_labels           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  conversations_resolved    BOOLEAN     NOT NULL DEFAULT FALSE,
  merged_at                 TIMESTAMPTZ,
  merge_sha                 TEXT,
  closed_at                 TIMESTAMPTZ,
  version                   INTEGER     NOT NULL DEFAULT 1,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(feature_run_id)
);

CREATE INDEX idx_pull_requests_feature_run_id ON pull_requests(feature_run_id);
CREATE INDEX idx_pull_requests_pr_number ON pull_requests(pr_number);
