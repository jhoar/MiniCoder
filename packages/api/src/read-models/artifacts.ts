/**
 * Read models for "artifacts" and "design documents" (docs/01 §9).
 */
import type { DbClient } from '@minicoder/core';
import { listByCreatedAt, type CursorPage, type ListParams } from '../pagination.js';
import { getByIdOrThrow } from './helpers.js';

export interface ArtifactExportRow {
  id: string;
  project_id: string;
  artifact_type: string;
  state: string;
  content: string | null;
  format: string;
  exported_at: string | null;
  error: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export function listArtifactExports(
  db: DbClient,
  projectId: string,
  params: ListParams,
): Promise<CursorPage<ArtifactExportRow>> {
  return listByCreatedAt<ArtifactExportRow>(
    db,
    {
      table: 'artifact_exports',
      columns:
        'id, project_id, artifact_type, state, content, format, exported_at, error, version, created_at, updated_at',
      where: 'project_id = ?',
      params: [projectId],
    },
    params,
  );
}

export function getArtifactExport(db: DbClient, id: string): Promise<ArtifactExportRow> {
  return getByIdOrThrow<ArtifactExportRow>(
    db,
    'artifact_exports',
    'id, project_id, artifact_type, state, content, format, exported_at, error, version, created_at, updated_at',
    id,
    'artifact-export',
  );
}

export interface DesignDocumentRow {
  id: string;
  project_id: string;
  state: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface DesignDocumentSectionRow {
  id: string;
  design_document_id: string;
  section_name: string;
  content: string | null;
  order_index: number;
}

export function listDesignDocuments(
  db: DbClient,
  projectId: string,
  params: ListParams,
): Promise<CursorPage<DesignDocumentRow>> {
  return listByCreatedAt<DesignDocumentRow>(
    db,
    {
      table: 'design_documents',
      columns: 'id, project_id, state, version, created_at, updated_at',
      where: 'project_id = ?',
      params: [projectId],
    },
    params,
  );
}

export async function getDesignDocument(
  db: DbClient,
  id: string,
): Promise<{ document: DesignDocumentRow; sections: DesignDocumentSectionRow[] }> {
  const document = await getByIdOrThrow<DesignDocumentRow>(
    db,
    'design_documents',
    'id, project_id, state, version, created_at, updated_at',
    id,
    'design-document',
  );
  const sections = await db.query<DesignDocumentSectionRow>(
    `SELECT id, design_document_id, section_name, content, order_index
     FROM design_document_sections WHERE design_document_id = ? ORDER BY order_index ASC`,
    [id],
  );
  return { document, sections };
}
