-- Clarification Workflow tables (docs/02-bootstrap-planner-clarification.md §4).
-- clarification_sessions persists the ClarificationStatus machine
-- (packages/core/src/statemachine/machines/clarification.ts); clarification_questions and
-- clarification_answers are the per-round question/answer records raised during an active
-- clarification session. Gaps and assumptions raised or resolved during clarification continue
-- to reuse planning_gaps / planning_assumptions via a nullable clarification_session_id — there
-- are no separate clarification_gaps / clarification_assumptions tables.

CREATE TABLE clarification_sessions (
  id                      TEXT    PRIMARY KEY,
  project_id              TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  specification_input_id  TEXT    REFERENCES specification_inputs(id),
  status                  TEXT    NOT NULL DEFAULT 'clarification_not_required',
  round                   INTEGER NOT NULL DEFAULT 0,
  max_rounds              INTEGER NOT NULL DEFAULT 3,
  round_timeout_at        TEXT,
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_clarification_sessions_project_id ON clarification_sessions(project_id);

CREATE TABLE clarification_questions (
  id                        TEXT    PRIMARY KEY,
  clarification_session_id TEXT    NOT NULL REFERENCES clarification_sessions(id) ON DELETE CASCADE,
  question                  TEXT    NOT NULL,
  round                      INTEGER NOT NULL DEFAULT 1,
  order_index                INTEGER NOT NULL DEFAULT 0,
  asked_at                   TEXT,
  answered_at                TEXT,
  version                    INTEGER NOT NULL DEFAULT 1,
  created_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_clarification_questions_session_id ON clarification_questions(clarification_session_id);

CREATE TABLE clarification_answers (
  id                          TEXT    PRIMARY KEY,
  clarification_question_id  TEXT    NOT NULL REFERENCES clarification_questions(id) ON DELETE CASCADE,
  answer                      TEXT    NOT NULL,
  actor                       TEXT    NOT NULL,
  actor_role                  TEXT    NOT NULL,
  answered_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  version                     INTEGER NOT NULL DEFAULT 1,
  created_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(clarification_question_id)
);

CREATE INDEX idx_clarification_answers_question_id ON clarification_answers(clarification_question_id);

CREATE TABLE clarification_decisions (
  id                         TEXT    PRIMARY KEY,
  clarification_session_id  TEXT    NOT NULL REFERENCES clarification_sessions(id) ON DELETE CASCADE,
  decision_type              TEXT    NOT NULL,
  actor                       TEXT    NOT NULL,
  actor_role                  TEXT    NOT NULL,
  notes                       TEXT,
  decided_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  version                     INTEGER NOT NULL DEFAULT 1,
  created_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_clarification_decisions_session_id ON clarification_decisions(clarification_session_id);

-- Reused gap/assumption tables gain a nullable link to the clarification session that raised or
-- resolved them (docs/02 §4). NULL means the row originated from the initial readiness assessment,
-- outside any clarification round.
ALTER TABLE planning_gaps ADD COLUMN clarification_session_id TEXT REFERENCES clarification_sessions(id);
ALTER TABLE planning_assumptions ADD COLUMN clarification_session_id TEXT REFERENCES clarification_sessions(id);

CREATE INDEX idx_planning_gaps_clarification_session_id ON planning_gaps(clarification_session_id);
CREATE INDEX idx_planning_assumptions_clarification_session_id ON planning_assumptions(clarification_session_id);
