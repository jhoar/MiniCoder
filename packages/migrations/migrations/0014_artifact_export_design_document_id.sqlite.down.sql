DROP INDEX IF EXISTS idx_artifact_exports_design_document_id;
ALTER TABLE artifact_exports DROP COLUMN design_document_id;
