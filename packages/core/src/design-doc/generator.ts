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

/** Matches the placeholder markers this module (and `ClaudeDocumentationAdapter`) substitute for
 * a missing/blank section — e.g. `(no content generated for Glossary)` /
 * `(no content drafted for Glossary)`. Exported so `ExportDesignDocumentHandler` can reject a
 * placeholder-filled section as an independent, adapter-implementation-agnostic backstop: a
 * caller-supplied `requiresRevision` flag is a *contract* every `DocumentationAgentAdapter`
 * implementation is expected to honor, not a guarantee this layer can itself enforce — a
 * non-compliant or buggy adapter could still report `requiresRevision: false` while a section
 * came back as this exact marker text. This mirrors `sanitizePromptSnapshot()`'s
 * "storage-boundary backstop, not a replacement for the adapter-level contract" posture. */
export const PLACEHOLDER_SECTION_CONTENT_PATTERN = /^\(no content (generated|drafted) for .+\)$/;

export function isPlaceholderSectionContent(content: string): boolean {
  return PLACEHOLDER_SECTION_CONTENT_PATTERN.test(content.trim());
}

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
  let hasMissingSection = false;
  const sections = DESIGN_DOCUMENT_SECTION_NAMES.map((sectionName) => {
    const content = bySectionName.get(sectionName);
    if (content === undefined || content.trim().length === 0) {
      hasMissingSection = true;
      return { sectionName, content: `(no content generated for ${sectionName})` };
    }
    return { sectionName, content };
  });

  return {
    documentId: output.documentId,
    sections,
    // A section the adapter didn't return (or returned empty) is a generation defect, not a
    // silently-acceptable placeholder — force requiresRevision so an incomplete document doesn't
    // pass through RecordDesignDocumentReadyCommand looking like a clean success.
    requiresRevision: output.requiresRevision || hasMissingSection,
  };
}
