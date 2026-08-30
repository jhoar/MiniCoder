import { describe, it, expect } from 'vitest';
import { generateId, DESIGN_DOCUMENT_SECTION_NAMES } from '@minicoder/core';
import type { DbClient } from '@minicoder/core';
import {
  buildTestApp,
  TEST_OPERATOR_KEY,
  TEST_VIEWER_KEY,
  seedProjectWithWorkflowState,
} from '../test-helpers.js';

async function seedDesignDocumentWithSections(db: DbClient, projectId: string): Promise<string> {
  const designDocumentId = generateId();
  await db.execute(
    `INSERT INTO design_documents (id, project_id, state, version, created_at, updated_at)
     VALUES (?, ?, 'draft', 1, datetime('now'), datetime('now'))`,
    [designDocumentId, projectId],
  );
  for (const sectionName of DESIGN_DOCUMENT_SECTION_NAMES) {
    await db.execute(
      `INSERT INTO design_document_sections (id, design_document_id, section_name, content, order_index, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 1, datetime('now'), datetime('now'))`,
      [generateId(), designDocumentId, sectionName, `content for ${sectionName}`],
    );
  }
  return designDocumentId;
}

async function seedNullBoundArtifactExport(db: DbClient, projectId: string): Promise<string> {
  const artifactExportId = generateId();
  await db.execute(
    `INSERT INTO artifact_exports (id, project_id, artifact_type, state, format, design_document_id, version, created_at, updated_at)
     VALUES (?, ?, 'design_document', 'pending', 'markdown', NULL, 1, datetime('now'), datetime('now'))`,
    [artifactExportId, projectId],
  );
  return artifactExportId;
}

describe('POST /commands/repair-design-document-binding', () => {
  it('requires operator role or higher', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const documentId = await seedDesignDocumentWithSections(db, projectId);
    const artifactExportId = await seedNullBoundArtifactExport(db, projectId);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/repair-design-document-binding',
      headers: { authorization: `Bearer ${TEST_VIEWER_KEY}` },
      payload: { projectId, artifactExportId, designDocumentId: documentId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires projectId, artifactExportId, and designDocumentId', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/commands/repair-design-document-binding',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown artifact export', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const documentId = await seedDesignDocumentWithSections(db, projectId);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/repair-design-document-binding',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { projectId, artifactExportId: 'nope', designDocumentId: documentId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('backfills a NULL binding and returns alreadyBound: false', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const documentId = await seedDesignDocumentWithSections(db, projectId);
    const artifactExportId = await seedNullBoundArtifactExport(db, projectId);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/repair-design-document-binding',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { projectId, artifactExportId, designDocumentId: documentId },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      alreadyBound: false,
      artifactExportId,
      designDocumentId: documentId,
    });

    const rows = await db.query<{ design_document_id: string | null }>(
      `SELECT design_document_id FROM artifact_exports WHERE id = ?`,
      [artifactExportId],
    );
    expect(rows[0]?.design_document_id).toBe(documentId);
  });

  it('rejects rebinding an already-bound artifact to a different document', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const boundDocumentId = await seedDesignDocumentWithSections(db, projectId);
    const otherDocumentId = await seedDesignDocumentWithSections(db, projectId);
    const artifactExportId = generateId();
    await db.execute(
      `INSERT INTO artifact_exports (id, project_id, artifact_type, state, format, design_document_id, version, created_at, updated_at)
       VALUES (?, ?, 'design_document', 'pending', 'markdown', ?, 1, datetime('now'), datetime('now'))`,
      [artifactExportId, projectId, boundDocumentId],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/commands/repair-design-document-binding',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { projectId, artifactExportId, designDocumentId: otherDocumentId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a designDocumentId belonging to a different project', async () => {
    const { app, db } = await buildTestApp();
    const { projectId } = await seedProjectWithWorkflowState(db);
    const { projectId: otherProjectId } = await seedProjectWithWorkflowState(db);
    const artifactExportId = await seedNullBoundArtifactExport(db, projectId);
    const otherProjectsDocumentId = await seedDesignDocumentWithSections(db, otherProjectId);

    const res = await app.inject({
      method: 'POST',
      url: '/commands/repair-design-document-binding',
      headers: { authorization: `Bearer ${TEST_OPERATOR_KEY}` },
      payload: { projectId, artifactExportId, designDocumentId: otherProjectsDocumentId },
    });
    expect(res.statusCode).toBe(404);
  });
});
