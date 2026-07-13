import type {
  DocumentationAgentAdapter,
  DocumentationInput,
  DocumentationOutput,
} from '../adapters/types.js';
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

/** Builds the narrow `DocumentationInput` (Phase 5-vintage adapter contract — `projectId`/
 * `planId`/`featureCount`/`correlationId` only) from DB-collected evidence. Split out from
 * `generateDesignDocumentSections()` (issue #72) so a caller that needs to route the adapter
 * invocation through `AgentRunRecorder` (which wraps a `() => Promise<Output>` thunk directly,
 * the same shape `run-coder.ts`/`run-review.ts` already use) can build the input once and pass it
 * to both the recorder and `normalizeDocumentationOutput()` below, without duplicating the
 * evidence-to-input mapping. */
export function buildDocumentationInput(
  evidence: DesignDocumentEvidence,
  opts: { planId: string; correlationId: string },
): DocumentationInput {
  return {
    projectId: evidence.project.id,
    planId: opts.planId,
    featureCount: evidence.features.length,
    correlationId: opts.correlationId,
  };
}

/** Normalizes a raw `DocumentationOutput` into the full, gap-filled 13-section result — the
 * placeholder-substitution and `requiresRevision` logic `generateDesignDocumentSections()` used to
 * perform inline, extracted (issue #72) so it can run *after* an already-invoked adapter call
 * (e.g. one wrapped by `AgentRunRecorder.record()`) instead of only as part of invoking the
 * adapter itself. */
export function normalizeDocumentationOutput(
  output: DocumentationOutput,
): GenerateDesignDocumentSectionsResult {
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

/**
 * Drives `DocumentationAgentAdapter.run()` with DB-collected evidence folded into the input. The
 * adapter contract (`DocumentationInput`, Phase 5-vintage) only carries `projectId`/`planId`/
 * `featureCount`/`correlationId` — it does not carry the full evidence bundle as structured
 * fields, mirroring how `CoderInput`/`ReviewerInput` also stay narrow and let the adapter itself
 * (or, for the reference implementation, `packages/adapters-documentation`) assemble a richer
 * prompt from a real evidence-fetch call of its own. This function's job is narrower: it is the
 * one call site every caller (tests, or a caller with no need for `AgentRunRecorder` provenance)
 * goes through, so evidence collection and adapter invocation are not duplicated per caller.
 *
 * `run-design-doc.ts` no longer calls this directly (issue #72) — it calls
 * `buildDocumentationInput()`, wraps the adapter invocation in `AgentRunRecorder.record()` itself
 * (for `agent_runs`/`agent_context_packs`/`cost_records` provenance), and then calls
 * `normalizeDocumentationOutput()` on the recorded result. This function is kept as the
 * simpler adapter+evidence-in, sections-out entry point for any caller that doesn't need that
 * provenance wrapping (and remains exactly what it always was, unchanged).
 */
export async function generateDesignDocumentSections(
  adapter: DocumentationAgentAdapter,
  evidence: DesignDocumentEvidence,
  opts: { planId: string; correlationId: string },
): Promise<GenerateDesignDocumentSectionsResult> {
  const output: DocumentationOutput = await adapter.run(buildDocumentationInput(evidence, opts));
  return normalizeDocumentationOutput(output);
}
