/**
 * Issue #71: a pre-migration-0014 (or manually-inserted) `artifact_exports` row with
 * `artifact_type = 'design_document'` and a NULL `design_document_id` is permanently
 * unexportable/unreadyable via the normal command path — `ExportDesignDocumentHandler`/
 * `RecordDesignDocumentReadyHandler` both fail closed on a NULL binding (CLAUDE.md's Final Design
 * Document Generator Operational Constraints), by design: silently accepting a NULL binding would
 * reopen the exact replay ambiguity migration 0014 exists to close, so there is no code path that
 * treats "no binding recorded" as "no check needed." `repairDesignDocumentBinding()` is the
 * supported operator recovery for that dead end — it only ever backfills a currently-NULL binding
 * after confirming the target `design_documents` row belongs to the same project; it never
 * overwrites an already-set binding (that would defeat the whole purpose of the column, and could
 * silently rebind an artifact to a document it wasn't actually rendered from).
 */
import { generateId, type DbClient } from '@minicoder/core';
import { NotFoundError, RequestValidationError } from '../errors.js';

export interface RepairDesignDocumentBindingResult {
  alreadyBound: boolean;
  artifactExportId: string;
  designDocumentId: string;
}

interface ArtifactExportRow {
  id: string;
  design_document_id: string | null;
}

function isoNow(): string {
  return new Date().toISOString();
}

export async function repairDesignDocumentBinding(
  db: DbClient,
  opts: {
    projectId: string;
    artifactExportId: string;
    designDocumentId: string;
    actorId: string;
  },
): Promise<RepairDesignDocumentBindingResult> {
  return db.transaction(async (tx) => {
    const artifactRows = await tx.query<ArtifactExportRow>(
      `SELECT id, design_document_id FROM artifact_exports
       WHERE id = ? AND project_id = ? AND artifact_type = 'design_document'`,
      [opts.artifactExportId, opts.projectId],
    );
    const artifact = artifactRows[0];
    if (!artifact) throw new NotFoundError('artifact_exports', opts.artifactExportId);

    if (artifact.design_document_id === opts.designDocumentId) {
      // Idempotent no-op: already bound to exactly the document the caller asked to bind — the
      // same "re-running a repair that already landed is safe" posture `state repair` establishes.
      return {
        alreadyBound: true,
        artifactExportId: opts.artifactExportId,
        designDocumentId: opts.designDocumentId,
      };
    }
    if (artifact.design_document_id !== null) {
      throw new RequestValidationError(
        `artifact_exports ${opts.artifactExportId} is already bound to design_documents ` +
          `${artifact.design_document_id}, not ${opts.designDocumentId} — this repair path only ` +
          `backfills a NULL binding, it never rebinds an already-bound artifact.`,
        'artifact-already-bound',
      );
    }

    // Confirms the target document belongs to the same project (the issue's own explicit
    // requirement) — a document from a different project simply won't be found here.
    const docRows = await tx.query<{ id: string }>(
      `SELECT id FROM design_documents WHERE id = ? AND project_id = ?`,
      [opts.designDocumentId, opts.projectId],
    );
    if (!docRows[0]) throw new NotFoundError('design_documents', opts.designDocumentId);

    const now = isoNow();
    const affected = await tx.executeAffected(
      `UPDATE artifact_exports SET design_document_id = ?, updated_at = ?
       WHERE id = ? AND design_document_id IS NULL`,
      [opts.designDocumentId, now, opts.artifactExportId],
    );
    if (affected === 0) {
      // A concurrent repair (or a concurrent normal generation cycle) bound this row between our
      // read above and this UPDATE — re-check rather than assume our own write raced silently.
      const recheck = await tx.query<ArtifactExportRow>(
        `SELECT id, design_document_id FROM artifact_exports WHERE id = ?`,
        [opts.artifactExportId],
      );
      if (recheck[0]?.design_document_id === opts.designDocumentId) {
        return {
          alreadyBound: true,
          artifactExportId: opts.artifactExportId,
          designDocumentId: opts.designDocumentId,
        };
      }
      throw new RequestValidationError(
        `artifact_exports ${opts.artifactExportId} was bound to a different design_documents row ` +
          `by a concurrent request; retry with the current binding.`,
        'artifact-already-bound',
      );
    }

    // Audited, not a bare UPDATE (issue #71's own requirement) — mirrors `state repair`'s
    // mutation-plus-event-insert-in-one-transaction convention.
    await tx.execute(
      `INSERT INTO workflow_events (id, project_id, event_type, from_state, to_state, actor, payload, payload_schema_version, occurred_at, created_at)
       VALUES (?, ?, 'artifact_export.binding_repaired', NULL, NULL, ?, ?, '1.0', ?, ?)`,
      [
        generateId(),
        opts.projectId,
        opts.actorId,
        JSON.stringify({
          artifactExportId: opts.artifactExportId,
          designDocumentId: opts.designDocumentId,
        }),
        now,
        now,
      ],
    );

    return {
      alreadyBound: false,
      artifactExportId: opts.artifactExportId,
      designDocumentId: opts.designDocumentId,
    };
  });
}
