-- Backlog validation gate (code review HIGH-1) and clarification-session provenance (MEDIUM-1).
--
-- implementation_plans gains a version-scoped validation record: backlog_version increments each
-- time a plan's feature_requests are (re)written; backlog_validated_state/backlog_validated_at are
-- the outcome of the most recent ValidateBacklogCommand run, and backlog_validated_version is the
-- backlog_version that was validated. SubmitPlanForApprovalCommand requires
-- backlog_validated_state = 'valid' AND backlog_validated_version = backlog_version, so a backlog
-- change (which resets the validated_* columns to NULL) invalidates any prior validation.
ALTER TABLE implementation_plans ADD COLUMN backlog_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE implementation_plans ADD COLUMN backlog_validated_at TEXT;
ALTER TABLE implementation_plans ADD COLUMN backlog_validated_state TEXT;
ALTER TABLE implementation_plans ADD COLUMN backlog_validated_version INTEGER;

-- clarification_sessions gains exact provenance to the readiness assessment that created it, so
-- GenerateImplementationPlanCommand can look up the session tied to the assessment being used
-- instead of "the project's most recent clarification session" (which is ambiguous across
-- multiple assessments in the same project).
ALTER TABLE clarification_sessions ADD COLUMN assessment_id TEXT REFERENCES planning_readiness_assessments(id);
CREATE INDEX idx_clarification_sessions_assessment_id ON clarification_sessions(assessment_id);
