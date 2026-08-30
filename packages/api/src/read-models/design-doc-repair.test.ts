import { describe, it, expect } from 'vitest';
import { createTestDb } from '@minicoder/testing';
import {
  generateId,
  ExportDesignDocumentHandler,
  TransactionalCommandExecutor,
  DESIGN_DOCUMENT_SECTION_NAMES,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import { repairDesignDocumentBinding } from './design-doc-repair.js';
import { NotFoundError, RequestValidationError } from '../errors.js';

const systemActor = {
  id: 'system',
  role: 'admin' as const,
  actorKind: 'system' as const,
  correlationId: 'corr-1',
};

async function seedProject(db: DbClient, projectId: string): Promise<void> {
  await db.execute(
    `INSERT INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Test Project', 'design_document_generating', 1, datetime('now'), datetime('now'))`,
    [projectId],
  );
}

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

describe('repairDesignDocumentBinding (issue #71)', () => {
  it('backfills a NULL binding and records an audit workflow_events row', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-repair-1';
    await seedProject(db, projectId);
    const documentId = await seedDesignDocumentWithSections(db, projectId);
    const artifactExportId = await seedNullBoundArtifactExport(db, projectId);

    const result = await repairDesignDocumentBinding(db, {
      projectId,
      artifactExportId,
      designDocumentId: documentId,
      actorId: 'test-operator',
    });

    expect(result).toEqual({ alreadyBound: false, artifactExportId, designDocumentId: documentId });

    const rows = await db.query<{ design_document_id: string | null }>(
      `SELECT design_document_id FROM artifact_exports WHERE id = ?`,
      [artifactExportId],
    );
    expect(rows[0]?.design_document_id).toBe(documentId);

    const events = await db.query<{ event_type: string; actor: string; payload: string }>(
      `SELECT event_type, actor, payload FROM workflow_events WHERE project_id = ? AND event_type = 'artifact_export.binding_repaired'`,
      [projectId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe('test-operator');
    expect(JSON.parse(events[0]!.payload)).toEqual({
      artifactExportId,
      designDocumentId: documentId,
    });
  });

  it('is idempotent: repeating the same repair returns alreadyBound without a second audit row', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-repair-2';
    await seedProject(db, projectId);
    const documentId = await seedDesignDocumentWithSections(db, projectId);
    const artifactExportId = await seedNullBoundArtifactExport(db, projectId);

    await repairDesignDocumentBinding(db, {
      projectId,
      artifactExportId,
      designDocumentId: documentId,
      actorId: 'test-operator',
    });
    const second = await repairDesignDocumentBinding(db, {
      projectId,
      artifactExportId,
      designDocumentId: documentId,
      actorId: 'test-operator',
    });

    expect(second).toEqual({ alreadyBound: true, artifactExportId, designDocumentId: documentId });
    const events = await db.query<{ id: string }>(
      `SELECT id FROM workflow_events WHERE project_id = ? AND event_type = 'artifact_export.binding_repaired'`,
      [projectId],
    );
    expect(events).toHaveLength(1);
  });

  it('rejects rebinding to a different document — never overwrites an existing binding', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-repair-3';
    await seedProject(db, projectId);
    const boundDocumentId = await seedDesignDocumentWithSections(db, projectId);
    const otherDocumentId = await seedDesignDocumentWithSections(db, projectId);
    const artifactExportId = generateId();
    await db.execute(
      `INSERT INTO artifact_exports (id, project_id, artifact_type, state, format, design_document_id, version, created_at, updated_at)
       VALUES (?, ?, 'design_document', 'pending', 'markdown', ?, 1, datetime('now'), datetime('now'))`,
      [artifactExportId, projectId, boundDocumentId],
    );

    await expect(
      repairDesignDocumentBinding(db, {
        projectId,
        artifactExportId,
        designDocumentId: otherDocumentId,
        actorId: 'test-operator',
      }),
    ).rejects.toBeInstanceOf(RequestValidationError);

    const rows = await db.query<{ design_document_id: string | null }>(
      `SELECT design_document_id FROM artifact_exports WHERE id = ?`,
      [artifactExportId],
    );
    expect(rows[0]?.design_document_id).toBe(boundDocumentId);
  });

  it('rejects an unknown artifactExportId', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-repair-4';
    await seedProject(db, projectId);
    const documentId = await seedDesignDocumentWithSections(db, projectId);

    await expect(
      repairDesignDocumentBinding(db, {
        projectId,
        artifactExportId: 'does-not-exist',
        designDocumentId: documentId,
        actorId: 'test-operator',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a designDocumentId belonging to a different project', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-repair-5';
    const otherProjectId = 'proj-repair-5-other';
    await seedProject(db, projectId);
    await seedProject(db, otherProjectId);
    const artifactExportId = await seedNullBoundArtifactExport(db, projectId);
    const otherProjectsDocumentId = await seedDesignDocumentWithSections(db, otherProjectId);

    await expect(
      repairDesignDocumentBinding(db, {
        projectId,
        artifactExportId,
        designDocumentId: otherProjectsDocumentId,
        actorId: 'test-operator',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const rows = await db.query<{ design_document_id: string | null }>(
      `SELECT design_document_id FROM artifact_exports WHERE id = ?`,
      [artifactExportId],
    );
    expect(rows[0]?.design_document_id).toBeNull();
  });

  // Closes the loop on `design-document-artifact-binding.test.ts`'s "fails closed for a NULL-bound
  // (legacy/pre-migration) artifact row" coverage: this is the recovery path that unblocks it.
  it('unblocks ExportDesignDocumentHandler once the binding is repaired', async () => {
    const db = createTestDb() as unknown as DbClient;
    const projectId = 'proj-repair-6';
    await seedProject(db, projectId);
    const documentId = await seedDesignDocumentWithSections(db, projectId);
    const artifactExportId = await seedNullBoundArtifactExport(db, projectId);

    const executor = new TransactionalCommandExecutor(db);
    const handler = new ExportDesignDocumentHandler();
    const envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: 'export-after-repair-1',
      payload: { projectId, designDocumentId: documentId, artifactExportId },
      actor: systemActor,
      correlationId: 'corr-1',
    };

    // Before repair: fails closed, exactly as design-document-artifact-binding.test.ts proves.
    await expect(executor.execute(handler, envelope)).rejects.toMatchObject({
      problem: { type: 'design-document-mismatch' },
    });

    await repairDesignDocumentBinding(db, {
      projectId,
      artifactExportId,
      designDocumentId: documentId,
      actorId: 'test-operator',
    });

    // After repair: the same command now succeeds against the same row.
    const result = await executor.execute(new ExportDesignDocumentHandler(), {
      ...envelope,
      idempotencyKey: 'export-after-repair-2',
    });
    expect(result.accepted).toBe(true);
    expect(result.resultingState).toBe('exported');
  });
});
