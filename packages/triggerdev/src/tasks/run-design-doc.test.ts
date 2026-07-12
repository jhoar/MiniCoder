import { describe, it, expect } from 'vitest';
import type { DbClient, DocumentationAgentAdapter, DocumentationOutput } from '@minicoder/core';
import { ProjectState, AgentRole, AdapterRegistry, generateId } from '@minicoder/core';
import { createTestDb, insertTestProject } from '../test-helpers.js';
import { runImpl, type DocumentationAdapterFactory } from './run-design-doc.js';

const PROJECT_ID = 'proj-run-design-doc-001';

async function seedGeneratingProject(
  db: DbClient,
): Promise<{ designDocumentId: string; artifactExportId: string }> {
  insertTestProject(db as never, PROJECT_ID);
  await db.execute(`UPDATE projects SET state = ?, version = 1 WHERE id = ?`, [
    ProjectState.DESIGN_DOCUMENT_GENERATING,
    PROJECT_ID,
  ]);
  await new AdapterRegistry(db).register({
    role: AgentRole.DOCUMENTATION,
    name: 'FakeAdapter',
    implementation: 'test:FakeAdapter',
    capabilities: ['can_generate_design_document'],
  });

  const designDocumentId = generateId();
  await db.execute(
    `INSERT INTO design_documents (id, project_id, state, version, created_at, updated_at)
     VALUES (?, ?, 'draft', 1, datetime('now'), datetime('now'))`,
    [designDocumentId, PROJECT_ID],
  );

  const artifactExportId = generateId();
  await db.execute(
    `INSERT INTO artifact_exports (id, project_id, artifact_type, state, format, version, created_at, updated_at)
     VALUES (?, ?, 'design_document', 'pending', 'markdown', 1, datetime('now'), datetime('now'))`,
    [artifactExportId, PROJECT_ID],
  );

  return { designDocumentId, artifactExportId };
}

function fakeAdapterFactory(output: DocumentationOutput): DocumentationAdapterFactory {
  const adapter: DocumentationAgentAdapter = {
    role: 'DocumentationAgentAdapter',
    async run() {
      return output;
    },
  };
  return async () => adapter;
}

describe('runImpl (run-design-doc)', () => {
  it('writes sections but does not export or record-ready when the adapter reports requiresRevision', async () => {
    const db = createTestDb();
    const { designDocumentId, artifactExportId } = await seedGeneratingProject(db);

    const result = await runImpl(
      {
        projectId: PROJECT_ID,
        documentationAdapterName: 'FakeAdapter',
        correlationId: 'corr-1',
        idempotencyKey: 'idem-1',
      },
      db,
      {
        documentationAdapterFactory: fakeAdapterFactory({
          documentId: 'doc-1',
          sections: [{ sectionName: 'Purpose and Scope', content: 'partial content' }],
          requiresRevision: true,
        }),
      },
    );

    expect(result.generated).toBe(false);
    expect(result.requiresRevision).toBe(true);

    const sectionRows = await db.query<{ id: string }>(
      `SELECT id FROM design_document_sections WHERE design_document_id = ?`,
      [designDocumentId],
    );
    expect(sectionRows.length).toBeGreaterThan(0);

    const artifactRows = await db.query<{ state: string }>(
      `SELECT state FROM artifact_exports WHERE id = ?`,
      [artifactExportId],
    );
    expect(artifactRows[0]?.state).toBe('pending');

    const projectRows = await db.query<{ state: string }>(
      `SELECT state FROM projects WHERE id = ?`,
      [PROJECT_ID],
    );
    expect(projectRows[0]?.state).toBe(ProjectState.DESIGN_DOCUMENT_GENERATING);
  });

  it('exports and records ready when the adapter reports a complete document', async () => {
    const db = createTestDb();
    await seedGeneratingProject(db);

    const { DESIGN_DOCUMENT_SECTION_NAMES } = await import('@minicoder/core');
    const result = await runImpl(
      {
        projectId: PROJECT_ID,
        documentationAdapterName: 'FakeAdapter',
        correlationId: 'corr-2',
        idempotencyKey: 'idem-2',
      },
      db,
      {
        documentationAdapterFactory: fakeAdapterFactory({
          documentId: 'doc-2',
          sections: DESIGN_DOCUMENT_SECTION_NAMES.map((sectionName: string) => ({
            sectionName,
            content: `content for ${sectionName}`,
          })),
          requiresRevision: false,
        }),
      },
    );

    expect(result.generated).toBe(true);

    const projectRows = await db.query<{ state: string }>(
      `SELECT state FROM projects WHERE id = ?`,
      [PROJECT_ID],
    );
    expect(projectRows[0]?.state).toBe(ProjectState.DESIGN_DOCUMENT_READY_FOR_REVIEW);
  });

  it('treats a concurrent invocation for the same project as a clean no-op instead of racing', async () => {
    const db = createTestDb();
    await seedGeneratingProject(db);

    const { DESIGN_DOCUMENT_SECTION_NAMES } = await import('@minicoder/core');
    let resolveFirstAdapterCall: (() => void) | undefined;
    const firstAdapterStarted = new Promise<void>((resolve) => {
      resolveFirstAdapterCall = resolve;
    });
    let releaseFirstAdapterCall: (() => void) | undefined;
    const firstAdapterGate = new Promise<void>((resolve) => {
      releaseFirstAdapterCall = resolve;
    });

    const slowAdapter: DocumentationAgentAdapter = {
      role: 'DocumentationAgentAdapter',
      async run() {
        resolveFirstAdapterCall?.();
        await firstAdapterGate;
        return {
          documentId: 'doc-slow',
          sections: DESIGN_DOCUMENT_SECTION_NAMES.map((sectionName: string) => ({
            sectionName,
            content: `slow content for ${sectionName}`,
          })),
          requiresRevision: false,
        };
      },
    };

    const firstRun = runImpl(
      {
        projectId: PROJECT_ID,
        documentationAdapterName: 'FakeAdapter',
        correlationId: 'corr-slow',
        idempotencyKey: 'idem-slow',
      },
      db,
      { documentationAdapterFactory: async () => slowAdapter },
    );

    await firstAdapterStarted;

    const secondResult = await runImpl(
      {
        projectId: PROJECT_ID,
        documentationAdapterName: 'FakeAdapter',
        correlationId: 'corr-fast',
        idempotencyKey: 'idem-fast',
      },
      db,
      {
        documentationAdapterFactory: fakeAdapterFactory({
          documentId: 'doc-fast',
          sections: DESIGN_DOCUMENT_SECTION_NAMES.map((sectionName: string) => ({
            sectionName,
            content: `fast content for ${sectionName}`,
          })),
          requiresRevision: false,
        }),
      },
    );

    expect(secondResult.generated).toBe(false);

    releaseFirstAdapterCall?.();
    const firstResult = await firstRun;
    expect(firstResult.generated).toBe(true);
  });
});
