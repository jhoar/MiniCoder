-- PR #68 review finding (MEDIUM-1): artifact_exports had no durable association to the
-- design_documents row it was rendered from. ExportDesignDocumentHandler/RecordDesignDocumentReadyHandler
-- could only validate that a caller-supplied designDocumentId existed for the project and had
-- complete sections -- not that it was actually the document a given already-exported artifact
-- was generated from. A system replay could pair an already-exported artifact with a different,
-- also-complete design_documents row in the same project and receive success.
--
-- design_document_id is nullable: it only applies to artifact_exports rows with
-- artifact_type = 'design_document' -- 'plan'/'backlog' exports (Phase 6) have no design document
-- to associate with, and this column must not require backfilling a value for them.
ALTER TABLE artifact_exports ADD COLUMN design_document_id TEXT REFERENCES design_documents(id);

CREATE INDEX idx_artifact_exports_design_document_id ON artifact_exports(design_document_id);
