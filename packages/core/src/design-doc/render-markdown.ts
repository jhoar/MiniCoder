import { DESIGN_DOCUMENT_SECTION_NAMES } from './generator.js';

export interface DesignDocumentSectionRow {
  sectionName: string;
  content: string;
  orderIndex: number;
}

export interface DesignDecisionRow {
  title: string;
  context: string | null;
  decision: string;
  consequences: string | null;
  status: string;
}

export interface GlossaryTermRow {
  term: string;
  definition: string;
  category: string | null;
}

/**
 * Renders `final-design-document.md` from `design_document_sections` + `design_decisions` +
 * `glossary_terms` — the "generate" step producing importable-artifact Markdown, matching this
 * codebase's "Markdown artifacts are never runtime state" rule (CLAUDE.md's locked decision #8)
 * and mirroring `ExportBacklogHandler`'s render shape. The "Design Decisions" and "Glossary"
 * sections' free-text `design_document_sections` content (the adapter's narrative prose) is
 * followed by a structured table rendered directly from `design_decisions`/`glossary_terms`, so
 * the exported document carries both the adapter's narrative and the exact structured audit rows.
 */
/** Escapes a value for use inside a single Markdown table cell: pipes (column separator) and
 * newlines (row separator) both corrupt a table if left raw. Applied to every cell, not just the
 * free-text ones, since any column here can carry user- or model-controlled text. */
function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ');
}

export function renderDesignDocumentMarkdown(opts: {
  projectName: string;
  sections: DesignDocumentSectionRow[];
  designDecisions: DesignDecisionRow[];
  glossaryTerms: GlossaryTermRow[];
}): string {
  const bySectionName = new Map(opts.sections.map((s) => [s.sectionName, s.content]));
  const lines: string[] = [`# Final Design Document: ${opts.projectName}`, ''];

  for (const sectionName of DESIGN_DOCUMENT_SECTION_NAMES) {
    lines.push(`## ${sectionName}`, '', bySectionName.get(sectionName) ?? '(no content)', '');

    if (sectionName === 'Design Decisions' && opts.designDecisions.length > 0) {
      lines.push('| Title | Status | Decision |', '| --- | --- | --- |');
      for (const d of opts.designDecisions) {
        lines.push(
          `| ${escapeTableCell(d.title)} | ${escapeTableCell(d.status)} | ${escapeTableCell(d.decision)} |`,
        );
      }
      lines.push('');
    }

    if (sectionName === 'Glossary' && opts.glossaryTerms.length > 0) {
      lines.push('| Term | Definition |', '| --- | --- |');
      for (const g of opts.glossaryTerms) {
        lines.push(`| ${escapeTableCell(g.term)} | ${escapeTableCell(g.definition)} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
