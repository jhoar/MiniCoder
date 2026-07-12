-- PR #68 review finding (MEDIUM-1): see the SQLite migration's header comment for the full
-- rationale.
ALTER TABLE artifact_exports ADD COLUMN IF NOT EXISTS design_document_id TEXT REFERENCES design_documents(id);

CREATE INDEX IF NOT EXISTS idx_artifact_exports_design_document_id ON artifact_exports(design_document_id);
