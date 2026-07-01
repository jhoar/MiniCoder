ALTER TABLE adapter_conformance_results ADD COLUMN IF NOT EXISTS skipped_tests INTEGER NOT NULL DEFAULT 0;
