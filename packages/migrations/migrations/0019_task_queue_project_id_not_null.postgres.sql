-- Issue #77: see the SQLite migration's header comment for the full rationale (why NULL rows are
-- safe to delete rather than reject the migration outright, and why NOT NULL is the correct
-- schema-level invariant here). PostgreSQL supports ALTER COLUMN directly -- no table rebuild
-- needed the way SQLite requires.
DELETE FROM task_queue WHERE project_id IS NULL;
ALTER TABLE task_queue ALTER COLUMN project_id SET NOT NULL;
