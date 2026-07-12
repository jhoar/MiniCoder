import { isoNow } from '../commands/helpers.js';
import type { DbClient, TxClient } from '../persistence/types.js';

/**
 * Evidence-data writer for `design_document_sections` — not a `CommandHandler` (writing generated
 * section content is not itself a state-machine mutation, the same category as
 * `insertReviewFindings()`). Upserts on the table's own `UNIQUE(design_document_id,
 * section_name)` constraint so a retried/regenerated call overwrites the prior content for that
 * section rather than erroring or duplicating rows.
 */
export async function writeDesignDocumentSections(
  db: DbClient | TxClient,
  opts: {
    designDocumentId: string;
    sections: Array<{ sectionName: string; content: string }>;
  },
): Promise<void> {
  const now = isoNow();
  for (const [index, section] of opts.sections.entries()) {
    await db.execute(
      `INSERT INTO design_document_sections
         (id, design_document_id, section_name, content, order_index, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (design_document_id, section_name)
       DO UPDATE SET content = excluded.content, order_index = excluded.order_index, version = design_document_sections.version + 1, updated_at = excluded.updated_at`,
      [
        `design-doc-section:${opts.designDocumentId}:${index}`,
        opts.designDocumentId,
        section.sectionName,
        section.content,
        index,
        now,
        now,
      ],
    );
  }
}
