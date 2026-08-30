/**
 * `POST /commands/repair-design-document-binding` (issue #71) — the supported operator recovery
 * path for a pre-migration-0014 (or manually-inserted) `artifact_exports` row that is permanently
 * unexportable/unreadyable because it has a NULL `design_document_id`. See
 * `read-models/design-doc-repair.ts`'s module doc comment for why `ExportDesignDocumentHandler`/
 * `RecordDesignDocumentReadyHandler` cannot simply treat a NULL binding as "no check needed," and
 * why this route never overwrites an already-set binding.
 *
 * Not dispatched through `TransactionalCommandExecutor` — there is no matrix-defined state
 * transition here (`design_document_id` is a binding column, not a state-machine field) — so it
 * requires `requireRole()` explicitly, the same posture `diagnostics-routes.ts`/
 * `finalize-if-github-merged-route.ts` already establish for a non-command DB-repair action. No
 * `Idempotency-Key` header is required: the underlying repair is naturally idempotent (a
 * CAS-guarded UPDATE, re-checked on a concurrent-write race), the same shape
 * `finalize-if-github-merged-route.ts` already uses for its own recovery action.
 */
import type { FastifyInstance } from 'fastify';
import { UserRole, type DbClient } from '@minicoder/core';
import { repairDesignDocumentBinding } from '../read-models/design-doc-repair.js';
import { RequestValidationError } from '../errors.js';
import { requireRole } from '../auth/require-role.js';

export interface RepairDesignDocumentBindingRouteDeps {
  db: DbClient;
}

interface RepairDesignDocumentBindingBody {
  projectId?: string;
  artifactExportId?: string;
  designDocumentId?: string;
}

export function registerRepairDesignDocumentBindingRoute(
  app: FastifyInstance,
  deps: RepairDesignDocumentBindingRouteDeps,
): void {
  app.post<{ Body: RepairDesignDocumentBindingBody }>(
    '/commands/repair-design-document-binding',
    async (request, reply) => {
      requireRole(request, UserRole.OPERATOR, 'repair-design-document-binding');
      const { projectId, artifactExportId, designDocumentId } = request.body ?? {};
      if (!projectId || !artifactExportId || !designDocumentId) {
        throw new RequestValidationError(
          'projectId, artifactExportId, and designDocumentId are all required',
        );
      }

      const result = await repairDesignDocumentBinding(deps.db, {
        projectId,
        artifactExportId,
        designDocumentId,
        actorId: request.actor!.id,
      });
      return reply.code(200).send(result);
    },
  );
}
