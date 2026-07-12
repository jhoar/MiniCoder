import { describe, it, expect } from 'vitest';
import {
  ExportDesignDocumentHandler,
  RecordDesignDocumentReadyHandler,
  ProjectState,
  TransactionalCommandExecutor,
  DESIGN_DOCUMENT_SECTION_NAMES,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import { createTestDb } from './db.js';

const PROJECT_ID = 'proj-artifact-binding-001';

const systemActor = {
  id: 'system',
  role: 'admin' as const,
  actorKind: 'system' as const,
  correlationId: 'corr-1',
};

async function seedProject(db: DbClient): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', ?, 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID, ProjectState.DESIGN_DOCUMENT_GENERATING],
  );
}

async function seedDesignDocumentWithSections(
  db: DbClient,
  opts: { state: string },
): Promise<string> {
  const designDocumentId = generateId();
  await db.execute(
    `INSERT INTO design_documents (id, project_id, state, version, created_at, updated_at)
     VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`,
    [designDocumentId, PROJECT_ID, opts.state],
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

async function seedArtifactExport(
  db: DbClient,
  opts: { state: string; designDocumentId: string },
): Promise<string> {
  const artifactExportId = generateId();
  await db.execute(
    `INSERT INTO artifact_exports (id, project_id, artifact_type, state, format, design_document_id, version, created_at, updated_at)
     VALUES (?, ?, 'design_document', ?, 'markdown', ?, 1, datetime('now'), datetime('now'))`,
    [artifactExportId, PROJECT_ID, opts.state, opts.designDocumentId],
  );
  return artifactExportId;
}

describe('artifact_exports.design_document_id binding (migration 0014)', () => {
  it('ExportDesignDocumentHandler rejects a designDocumentId that does not match the artifact', async () => {
    const db = createTestDb();
    await seedProject(db);
    const realDocumentId = await seedDesignDocumentWithSections(db, { state: 'draft' });
    const otherDocumentId = await seedDesignDocumentWithSections(db, { state: 'draft' });
    const artifactExportId = await seedArtifactExport(db, {
      state: 'pending',
      designDocumentId: realDocumentId,
    });

    const executor = new TransactionalCommandExecutor(db);
    const handler = new ExportDesignDocumentHandler();

    await expect(
      executor.execute(handler, {
        commandId: generateId(),
        idempotencyKey: 'export-mismatch-1',
        payload: { projectId: PROJECT_ID, designDocumentId: otherDocumentId, artifactExportId },
        actor: systemActor,
        correlationId: 'corr-1',
      } as CommandEnvelope<Record<string, unknown>>),
    ).rejects.toMatchObject({ problem: { type: 'design-document-mismatch' } });
  });

  it('RecordDesignDocumentReadyHandler rejects a designDocumentId that does not match the exported artifact', async () => {
    const db = createTestDb();
    await seedProject(db);
    const realDocumentId = await seedDesignDocumentWithSections(db, { state: 'draft' });
    const otherDocumentId = await seedDesignDocumentWithSections(db, { state: 'draft' });
    const artifactExportId = await seedArtifactExport(db, {
      state: 'exported',
      designDocumentId: realDocumentId,
    });

    const executor = new TransactionalCommandExecutor(db);
    const handler = new RecordDesignDocumentReadyHandler();

    await expect(
      executor.execute(handler, {
        commandId: generateId(),
        idempotencyKey: 'ready-mismatch-1',
        payload: {
          projectId: PROJECT_ID,
          expectedVersion: 1,
          designDocumentId: otherDocumentId,
          artifactExportId,
        },
        actor: systemActor,
        correlationId: 'corr-1',
      } as CommandEnvelope<Record<string, unknown>>),
    ).rejects.toMatchObject({ problem: { type: 'design-document-mismatch' } });
  });
});
