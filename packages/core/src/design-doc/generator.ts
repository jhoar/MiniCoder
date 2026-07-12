import type { DocumentationAgentAdapter, DocumentationOutput } from '../adapters/types.js';
import type { DesignDocumentEvidence } from './evidence.js';

/** The 13 required sections, exact names and order (docs/01 §13.2). Do not rename or reorder —
 * `design_document_sections.section_name` is `UNIQUE(design_document_id, section_name)`-keyed on
 * these exact strings, and `MockDocumentationAdapter` (packages/testing) already hard-codes this
 * same list. */
export const DESIGN_DOCUMENT_SECTION_NAMES = [
  'Purpose and Scope',
  'Goals and Constraints',
  'System Context',
  'Architecture Overview',
  'Component Design',
  'Data Design',
  'API and Interface Design',
  'Workflows and Runtime Behavior',
  'Deployment and Infrastructure',
  'Observability and Operations',
  'Testing Strategy',
  'Design Decisions',
  'Glossary',
] as const;

export interface GenerateDesignDocumentSectionsResult {
  readonly documentId: string;
  readonly sections: Array<{ sectionName: string; content: string }>;
  readonly requiresRevision: boolean;
}

/**
 * Drives `DocumentationAgentAdapter.run()` with DB-collected evidence folded into the input. The
 * adapter contract (`DocumentationInput`, Phase 5-vintage) only carries `projectId`/`planId`/
 * `featureCount`/`correlationId` — it does not carry the full evidence bundle as structured
 * fields, mirroring how `CoderInput`/`ReviewerInput` also stay narrow and let the adapter itself
 * (or, for the reference implementation, `packages/adapters-documentation`) assemble a richer
 * prompt from a real evidence-fetch call of its own. This function's job is narrower: it is the
 * one call site every caller (the `run-design-doc` task, tests) goes through, so evidence
 * collection and adapter invocation are not duplicated per caller.
 */
export async function generateDesignDocumentSections(
  adapter: DocumentationAgentAdapter,
  evidence: DesignDocumentEvidence,
  opts: { planId: string; correlationId: string },
): Promise<GenerateDesignDocumentSectionsResult> {
  const output: DocumentationOutput = await adapter.run({
    projectId: evidence.project.id,
    planId: opts.planId,
    featureCount: evidence.features.length,
    correlationId: opts.correlationId,
  });

  const bySectionName = new Map(output.sections.map((s) => [s.sectionName, s.content]));
  const sections = DESIGN_DOCUMENT_SECTION_NAMES.map((sectionName) => ({
    sectionName,
    content: bySectionName.get(sectionName) ?? `(no content generated for ${sectionName})`,
  }));

  return {
    documentId: output.documentId,
    sections,
    requiresRevision: output.requiresRevision,
  };
}
