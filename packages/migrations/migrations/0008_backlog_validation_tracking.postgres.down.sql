DROP INDEX IF EXISTS idx_clarification_sessions_assessment_id;
ALTER TABLE clarification_sessions DROP COLUMN IF EXISTS assessment_id;
ALTER TABLE implementation_plans DROP COLUMN IF EXISTS backlog_validated_version;
ALTER TABLE implementation_plans DROP COLUMN IF EXISTS backlog_validated_state;
ALTER TABLE implementation_plans DROP COLUMN IF EXISTS backlog_validated_at;
ALTER TABLE implementation_plans DROP COLUMN IF EXISTS backlog_version;
