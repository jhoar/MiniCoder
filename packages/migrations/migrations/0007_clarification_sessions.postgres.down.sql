DROP INDEX IF EXISTS idx_planning_assumptions_clarification_session_id;
DROP INDEX IF EXISTS idx_planning_gaps_clarification_session_id;
ALTER TABLE planning_assumptions DROP COLUMN IF EXISTS clarification_session_id;
ALTER TABLE planning_gaps DROP COLUMN IF EXISTS clarification_session_id;
DROP TABLE IF EXISTS clarification_decisions;
DROP TABLE IF EXISTS clarification_answers;
DROP TABLE IF EXISTS clarification_questions;
DROP TABLE IF EXISTS clarification_sessions;
