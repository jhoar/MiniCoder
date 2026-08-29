-- Reverts migration 0019: restores task_queue.project_id to nullable (its original migration
-- 0017 shape). No data loss on the way back.
ALTER TABLE task_queue ALTER COLUMN project_id DROP NOT NULL;
