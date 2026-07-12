import {
  TransactionalCommandExecutor,
  AdapterRegistry,
  AgentRole,
  MarkImplementationCompleteHandler,
  GenerateDesignDocumentHandler,
  RequestDesignDocumentRevisionHandler,
  RegenerateDesignDocumentHandler,
  ApproveDesignDocumentHandler,
  CompleteProjectHandler,
  ProjectState,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope } from '@minicoder/core';
import { runRunDesignDoc } from '@minicoder/triggerdev';
import type { RunDesignDocDeps } from '@minicoder/triggerdev';
import type { Scenario, ScenarioContext } from './types.js';

interface ProjectRow {
  id: string;
  state: string;
  version: number;
}

async function getProject(ctx: ScenarioContext): Promise<ProjectRow> {
  const rows = await ctx.db.query<ProjectRow>(
    `SELECT id, state, version FROM projects WHERE id = ?`,
    [ctx.projectId],
  );
  const row = rows[0];
  if (!row) throw new Error(`Project ${ctx.projectId} not found`);
  return row;
}

interface DesignDocumentRow {
  id: string;
  state: string;
}

async function getLatestDesignDocument(ctx: ScenarioContext): Promise<DesignDocumentRow> {
  const rows = await ctx.db.query<DesignDocumentRow>(
    `SELECT id, state FROM design_documents WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
    [ctx.projectId],
  );
  const row = rows[0];
  if (!row) throw new Error(`No design_documents row found for project ${ctx.projectId}`);
  return row;
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const markImplementationCompleteHandler = new MarkImplementationCompleteHandler();
const generateDesignDocumentHandler = new GenerateDesignDocumentHandler();
const requestDesignDocumentRevisionHandler = new RequestDesignDocumentRevisionHandler();
const regenerateDesignDocumentHandler = new RegenerateDesignDocumentHandler();
const approveDesignDocumentHandler = new ApproveDesignDocumentHandler();
const completeProjectHandler = new CompleteProjectHandler();

/**
 * Exercises the full Phase 17 project-lifecycle chain against the real handlers and the real
 * `run-design-doc` task (via `MockTriggerRunner`, injecting `MockDocumentationAdapter` as the
 * `documentationAdapterFactory`) — no hand-rolled SQL standing in for the state machine, matching
 * `merge-gate.ts`'s established pattern for this test tier:
 *
 *   active -> implementation_complete -> design_document_generating
 *   -> design_document_ready_for_review -> design_document_revision_requested
 *   -> design_document_generating -> design_document_ready_for_review
 *   -> design_document_approved -> project_complete
 *
 * Distinct from the pre-existing `final-design-document` scenario, which exercises the unrelated
 * `export-plan`/`export-backlog` tasks — this scenario is the Phase 17 project-lifecycle/
 * design-document-generation flow.
 */
export const designDocumentLifecycleScenario: Scenario = {
  name: 'design-document-lifecycle',
  description:
    'active -> implementation_complete -> design_document_generating -> ready_for_review -> ' +
    'revision_requested -> generating -> ready_for_review -> approved -> project_complete, via ' +
    'the real handlers and the real run-design-doc task',
  fixtureName: 'design-document-lifecycle',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId } = ctx;
    const correlationId = `corr-design-doc-lifecycle-${projectId}`;
    const executor = new TransactionalCommandExecutor(db);

    // run-design-doc.ts fails fast (UnknownAdapterError) on an unregistered documentationAdapterName
    // — register the mock the same way review-fix-loop.ts registers MockReviewerAdapter.
    await new AdapterRegistry(db).register({
      role: AgentRole.DOCUMENTATION,
      name: 'MockDocumentationAdapter',
      implementation: '@minicoder/testing:MockDocumentationAdapter',
      capabilities: ['can_generate_design_document'],
    });
    const operator = {
      id: 'operator-1',
      role: 'operator' as const,
      actorKind: 'human' as const,
      correlationId,
    };
    const approver = {
      id: 'approver-1',
      role: 'approver' as const,
      actorKind: 'human' as const,
      correlationId,
    };
    const system = {
      id: 'system',
      role: 'admin' as const,
      actorKind: 'system' as const,
      correlationId,
    };
    const deps: RunDesignDocDeps = {
      documentationAdapterFactory: async () => ctx.documentation,
    };

    // ── active -> implementation_complete (system, gated by Project Acceptance Validation) ──
    let project = await getProject(ctx);
    assertEqual('starts at active', project.state, ProjectState.ACTIVE);
    await executor.execute(markImplementationCompleteHandler, {
      commandId: generateId(),
      idempotencyKey: `implementation-complete:${projectId}:1`,
      payload: {
        projectId,
        expectedVersion: project.version,
        externalChecksEvidence: 'scenario: CI checks assumed green for this fixture',
      },
      actor: system,
      correlationId,
    } as CommandEnvelope<Record<string, unknown>>);
    project = await getProject(ctx);
    assertEqual(
      'reaches implementation_complete',
      project.state,
      ProjectState.IMPLEMENTATION_COMPLETE,
    );

    // ── implementation_complete -> design_document_generating (operator) ──
    await executor.execute(generateDesignDocumentHandler, {
      commandId: generateId(),
      idempotencyKey: `generate-design-doc:${projectId}:1`,
      payload: { projectId, expectedVersion: project.version },
      actor: operator,
      correlationId,
    } as CommandEnvelope<Record<string, unknown>>);
    project = await getProject(ctx);
    assertEqual(
      'reaches design_document_generating',
      project.state,
      ProjectState.DESIGN_DOCUMENT_GENERATING,
    );

    // ── run-design-doc: drafts sections via MockDocumentationAdapter, exports
    //    final-design-document.md, records the document ready ──
    const runResult = await ctx.runner.run(
      'run-design-doc',
      {
        projectId,
        correlationId,
        idempotencyKey: `run-design-doc:${projectId}:1`,
        documentationAdapterName: 'MockDocumentationAdapter',
      },
      runRunDesignDoc,
      undefined,
      deps,
    );
    if (!runResult.result.generated) {
      throw new Error(`run-design-doc did not generate: ${JSON.stringify(runResult.result)}`);
    }
    project = await getProject(ctx);
    assertEqual(
      'reaches design_document_ready_for_review',
      project.state,
      ProjectState.DESIGN_DOCUMENT_READY_FOR_REVIEW,
    );

    const sectionCountRows = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM design_document_sections WHERE design_document_id = ?`,
      [runResult.result.designDocumentId],
    );
    assertEqual('all 13 sections written', Number(sectionCountRows[0]?.n ?? 0), 13);

    const artifactRows = await db.query<{ state: string; content: string | null }>(
      `SELECT state, content FROM artifact_exports WHERE id = ?`,
      [runResult.result.artifactExportId],
    );
    assertEqual('artifact_exports reaches exported', artifactRows[0]?.state, 'exported');
    if (!artifactRows[0]?.content || !artifactRows[0].content.includes('Final Design Document')) {
      throw new Error('Expected exported final-design-document.md content, got none');
    }

    // ── design_document_ready_for_review -> design_document_revision_requested (approver) ──
    let doc = await getLatestDesignDocument(ctx);
    await executor.execute(requestDesignDocumentRevisionHandler, {
      commandId: generateId(),
      idempotencyKey: `request-design-revision:${projectId}:${project.version}`,
      payload: {
        projectId,
        expectedVersion: project.version,
        designDocumentId: doc.id,
        notes: 'Please expand Data Design',
      },
      actor: approver,
      correlationId,
    } as CommandEnvelope<Record<string, unknown>>);
    project = await getProject(ctx);
    assertEqual(
      'reaches design_document_revision_requested',
      project.state,
      ProjectState.DESIGN_DOCUMENT_REVISION_REQUESTED,
    );

    // ── design_document_revision_requested -> design_document_generating (operator) ──
    await executor.execute(regenerateDesignDocumentHandler, {
      commandId: generateId(),
      idempotencyKey: `regenerate-design-doc:${projectId}:${project.version}`,
      payload: { projectId, expectedVersion: project.version },
      actor: operator,
      correlationId,
    } as CommandEnvelope<Record<string, unknown>>);
    project = await getProject(ctx);
    assertEqual(
      'regeneration reaches design_document_generating',
      project.state,
      ProjectState.DESIGN_DOCUMENT_GENERATING,
    );

    // ── run-design-doc again for the regeneration cycle ──
    const runResult2 = await ctx.runner.run(
      'run-design-doc',
      {
        projectId,
        correlationId,
        idempotencyKey: `run-design-doc:${projectId}:2`,
        documentationAdapterName: 'MockDocumentationAdapter',
      },
      runRunDesignDoc,
      undefined,
      deps,
    );
    if (!runResult2.result.generated) {
      throw new Error(
        `run-design-doc (2nd cycle) did not generate: ${JSON.stringify(runResult2.result)}`,
      );
    }
    project = await getProject(ctx);
    assertEqual(
      'reaches design_document_ready_for_review again',
      project.state,
      ProjectState.DESIGN_DOCUMENT_READY_FOR_REVIEW,
    );

    // ── design_document_ready_for_review -> design_document_approved (approver) ──
    doc = await getLatestDesignDocument(ctx);
    await executor.execute(approveDesignDocumentHandler, {
      commandId: generateId(),
      idempotencyKey: `approve-design-doc:${projectId}:${project.version}`,
      payload: {
        projectId,
        expectedVersion: project.version,
        designDocumentId: doc.id,
        notes: 'LGTM',
      },
      actor: approver,
      correlationId,
    } as CommandEnvelope<Record<string, unknown>>);
    project = await getProject(ctx);
    assertEqual(
      'reaches design_document_approved',
      project.state,
      ProjectState.DESIGN_DOCUMENT_APPROVED,
    );

    // ── design_document_approved -> project_complete (system) ──
    await executor.execute(completeProjectHandler, {
      commandId: generateId(),
      idempotencyKey: `complete-project:${projectId}:${project.version}`,
      payload: { projectId, expectedVersion: project.version },
      actor: system,
      correlationId,
    } as CommandEnvelope<Record<string, unknown>>);
    project = await getProject(ctx);
    assertEqual('reaches project_complete', project.state, ProjectState.PROJECT_COMPLETE);
  },
};
