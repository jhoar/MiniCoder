-- GitHub branch/PR/CI/review-state persistence (docs/01-system-specification.md §5.7, Phase 7).
--
-- pull_requests mirrors GitHub-observed state for a feature_run's pull request. review_state and
-- ci_status are observed mirrors of GitHub, overwritten directly on reconciliation -- unlike the
-- other canonical state machines, PR/review state has no StateTransitionValidator matrix (GitHub
-- remains authoritative; see docs/00-glossary-and-terms.md §3.10 PrReviewState). One row per
-- feature_run (a feature run has at most one open pull request at a time).

CREATE TABLE pull_requests (
  id                       TEXT    PRIMARY KEY,
  feature_run_id           TEXT    NOT NULL REFERENCES feature_runs(id) ON DELETE CASCADE,
  pr_number                INTEGER NOT NULL,
  branch_name               TEXT    NOT NULL,
  base_branch                TEXT    NOT NULL,
  head_sha                   TEXT,
  state                      TEXT    NOT NULL DEFAULT 'open',
  review_state               TEXT    NOT NULL DEFAULT 'none',
  ci_status                  TEXT    NOT NULL DEFAULT 'pending',
  mergeable                  INTEGER,
  blocking_labels            TEXT    NOT NULL DEFAULT '[]',
  conversations_resolved     INTEGER NOT NULL DEFAULT 0,
  merged_at                  TEXT,
  merge_sha                  TEXT,
  closed_at                  TEXT,
  version                    INTEGER NOT NULL DEFAULT 1,
  created_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(feature_run_id)
);

CREATE INDEX idx_pull_requests_feature_run_id ON pull_requests(feature_run_id);
CREATE INDEX idx_pull_requests_pr_number ON pull_requests(pr_number);
