/**
 * `POST /commands/resolve-review-finding` (issue #116) — the human-disposition action for a
 * non-blocking review finding, closing the gap where only a fix-cycle push could ever mark
 * `review_findings.resolved`. See `read-models/review-finding-resolution.ts`'s module doc comment
 * for the full rationale.
 *
 * Not dispatched through `TransactionalCommandExecutor` — `review_findings` carries no
 * `StateTransitionValidator` matrix (`resolved` is a plain boolean column) — so it requires
 * `requireRole()` explicitly, the same posture `diagnostics-routes.ts`/
 * `repair-design-document-binding-route.ts` already establish for a non-command DB-write action.
 * No `Idempotency-Key` header is required: re-running the same disposition is a safe, append-only
 * `human_approvals` audit row plus an idempotent `resolved` flip (a no-op once already `TRUE`).
 */
import type { FastifyInstance } from 'fastify';
import { UserRole, type DbClient } from '@minicoder/core';
import { resolveReviewFinding } from '../read-models/review-finding-resolution.js';
import { RequestValidationError } from '../errors.js';
import { requireRole } from '../auth/require-role.js';

export interface ResolveReviewFindingRouteDeps {
  db: DbClient;
}

interface ResolveReviewFindingBody {
  findingId?: string;
  dismiss?: boolean;
  note?: string;
}

export function registerResolveReviewFindingRoute(
  app: FastifyInstance,
  deps: ResolveReviewFindingRouteDeps,
): void {
  app.post<{ Body: ResolveReviewFindingBody }>(
    '/commands/resolve-review-finding',
    async (request, reply) => {
      requireRole(request, UserRole.OPERATOR, 'resolve-review-finding');
      const { findingId, dismiss, note } = request.body ?? {};
      if (!findingId) {
        throw new RequestValidationError('findingId is required');
      }

      const result = await resolveReviewFinding(deps.db, {
        findingId,
        dismiss: dismiss === true,
        note,
        actorId: request.actor!.id,
        actorRole: request.actor!.role,
      });
      return reply.code(200).send(result);
    },
  );
}
