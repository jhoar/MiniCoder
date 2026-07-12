import { describe, it, expect, afterEach } from 'vitest';
import type { DbClient, DocumentationAgentAdapter, DocumentationOutput } from '@minicoder/core';
import { ProjectState, AgentRole, AdapterRegistry, generateId } from '@minicoder/core';
import { createTestDb, insertTestProject } from '../test-helpers.js';
import {
  runImpl,
  DEFAULT_DOCUMENTATION_ADAPTER_NAME,
  type DocumentationAdapterFactory,
} from './run-design-doc.js';

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
    `INSERT INTO artifact_exports (id, project_id, artifact_type, state, format, design_document_id, version, created_at, updated_at)
     VALUES (?, ?, 'design_document', 'pending', 'markdown', ?, 1, datetime('now'), datetime('now'))`,
    [artifactExportId, PROJECT_ID, designDocumentId],
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

  // Issue #72: run-design-doc now routes its adapter invocation through AgentRunRecorder.
  describe('AgentRunRecorder provenance (issue #72)', () => {
    afterEach(() => {
      delete process.env['DOCUMENTATION_PRICE_PER_1K_INPUT_TOKENS'];
      delete process.env['DOCUMENTATION_PRICE_PER_1K_OUTPUT_TOKENS'];
      delete process.env['DOCUMENTATION_PROMPT_TEMPLATE_VERSION'];
    });

    it('writes an agent_runs row with resolved adapter provenance and an agent_context_packs row', async () => {
      const db = createTestDb();
      const { DESIGN_DOCUMENT_SECTION_NAMES } = await import('@minicoder/core');
      await seedGeneratingProject(db);

      await runImpl(
        {
          projectId: PROJECT_ID,
          documentationAdapterName: 'FakeAdapter',
          correlationId: 'corr-provenance',
          idempotencyKey: 'idem-provenance',
        },
        db,
        {
          documentationAdapterFactory: fakeAdapterFactory({
            documentId: 'doc-provenance',
            sections: DESIGN_DOCUMENT_SECTION_NAMES.map((sectionName: string) => ({
              sectionName,
              content: `content for ${sectionName}`,
            })),
            requiresRevision: false,
          }),
        },
      );

      const runRows = await db.query<{
        id: string;
        role: string;
        adapter_name: string;
        prompt_template_version: string | null;
        project_id: string;
        feature_run_id: string | null;
      }>(`SELECT * FROM agent_runs WHERE project_id = ?`, [PROJECT_ID]);
      expect(runRows).toHaveLength(1);
      expect(runRows[0]?.role).toBe(AgentRole.DOCUMENTATION);
      expect(runRows[0]?.adapter_name).toBe('FakeAdapter');
      expect(runRows[0]?.prompt_template_version).toBe('documentation-v1');
      expect(runRows[0]?.feature_run_id).toBeNull();

      const contextPackRows = await db.query<{ id: string }>(
        `SELECT id FROM agent_context_packs WHERE agent_run_id = ?`,
        [runRows[0]!.id],
      );
      expect(contextPackRows.length).toBeGreaterThanOrEqual(1);
    });

    it('writes a cost_records row scoped to the project when the adapter reports token usage', async () => {
      const db = createTestDb();
      const { DESIGN_DOCUMENT_SECTION_NAMES } = await import('@minicoder/core');
      await seedGeneratingProject(db);

      const adapter: DocumentationAgentAdapter = {
        role: 'DocumentationAgentAdapter',
        async run() {
          return {
            documentId: 'doc-cost',
            sections: DESIGN_DOCUMENT_SECTION_NAMES.map((sectionName: string) => ({
              sectionName,
              content: `content for ${sectionName}`,
            })),
            requiresRevision: false,
            tokensUsed: { input: 1000, output: 2000 },
          } as DocumentationOutput & { tokensUsed: { input: number; output: number } };
        },
      };

      await runImpl(
        {
          projectId: PROJECT_ID,
          documentationAdapterName: 'FakeAdapter',
          correlationId: 'corr-cost',
          idempotencyKey: 'idem-cost',
        },
        db,
        { documentationAdapterFactory: async () => adapter },
      );

      const costRows = await db.query<{ scope: string; project_id: string; amount: number }>(
        `SELECT scope, project_id, amount FROM cost_records WHERE project_id = ?`,
        [PROJECT_ID],
      );
      expect(costRows).toHaveLength(1);
      expect(costRows[0]?.scope).toBe('project');
      expect(costRows[0]?.amount).toBeGreaterThan(0);
    });

    it('does not write a cost_records row when the adapter reports no token usage', async () => {
      const db = createTestDb();
      const { DESIGN_DOCUMENT_SECTION_NAMES } = await import('@minicoder/core');
      await seedGeneratingProject(db);

      await runImpl(
        {
          projectId: PROJECT_ID,
          documentationAdapterName: 'FakeAdapter',
          correlationId: 'corr-no-cost',
          idempotencyKey: 'idem-no-cost',
        },
        db,
        {
          documentationAdapterFactory: fakeAdapterFactory({
            documentId: 'doc-no-cost',
            sections: DESIGN_DOCUMENT_SECTION_NAMES.map((sectionName: string) => ({
              sectionName,
              content: `content for ${sectionName}`,
            })),
            requiresRevision: false,
          }),
        },
      );

      const costRows = await db.query<{ id: string }>(
        `SELECT id FROM cost_records WHERE project_id = ?`,
        [PROJECT_ID],
      );
      expect(costRows).toHaveLength(0);
    });
  });

  // Issue #70: the default (non-injected) adapter factory path only supports
  // DEFAULT_DOCUMENTATION_ADAPTER_NAME; a caller-injected factory (every test above) is exempt.
  describe('default-factory adapter name guard (issue #70)', () => {
    it('rejects a non-default documentationAdapterName when no factory is injected', async () => {
      const db = createTestDb();
      await seedGeneratingProject(db);

      await expect(
        runImpl(
          {
            projectId: PROJECT_ID,
            documentationAdapterName: 'FakeAdapter',
            correlationId: 'corr-reject',
            idempotencyKey: 'idem-reject',
          },
          db,
          {},
        ),
      ).rejects.toThrow(/FakeAdapter.*not supported/);
    });

    it('DEFAULT_DOCUMENTATION_ADAPTER_NAME matches the Web UI action constant', () => {
      // No shared export exists across the @minicoder/web / @minicoder/triggerdev boundary
      // (deliberately — see DEFAULT_DOCUMENTATION_ADAPTER_NAME's doc comment), so this pins the
      // one hardcoded value that must stay in sync with packages/web/src/app/design-document/actions.ts.
      expect(DEFAULT_DOCUMENTATION_ADAPTER_NAME).toBe('ClaudeDocumentationAdapter');
    });
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
