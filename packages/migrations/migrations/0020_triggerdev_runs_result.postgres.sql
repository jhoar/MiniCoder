-- Issue #122: see the SQLite migration's header comment for the full rationale.
ALTER TABLE triggerdev_runs ADD COLUMN result JSONB;
