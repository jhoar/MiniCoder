import { z } from 'zod';
import { UserRole } from '../../../domain/states.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import { OptimisticLockError } from '../../../persistence/types.js';
import { CommandError } from '../../types.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import {
  isoNow,
  writeWorkflowEvent,
  writeOutboxEvent,
  claimIdempotencyKey,
  fulfillIdempotencyKey,
  insertHumanApproval,
} from '../../helpers.js';

export const ResolvePlanningGapPayloadSchema = z.object({
  projectId: z.string(),
  assessmentId: z.string(),
  gapId: z.string(),
  resolution: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
});
export type ResolvePlanningGapPayload = z.infer<typeof ResolvePlanningGapPayloadSchema>;

export type ResolvePlanningGapResultState = 'resolved';

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface GapRow {
  id: string;
  severity: string;
  resolved_at: string | null;
  version: number;
}

/**
 * docs/02 §3: "Any blocking gap prevents activation unless resolved or explicitly accepted by an
 * authorized human." Before this handler, nothing anywhere in the codebase ever wrote
 * `planning_gaps.resolved_at`/`.resolution` — a readiness assessment carrying even one blocking
 * gap could never pass `SubmitPlanForApprovalHandler`'s unresolved-blocking-gaps check, with no
 * path forward at all (confirmed live against a real project). This is the missing "explicitly
 * accepted by an authorized human" override: an approver records a resolution note and the gap no
 * longer blocks submission. It does not touch `clarification_gaps`-style automated resolution via
 * answering clarification questions (there is no such table — `planning_gaps` is shared, per
 * CLAUDE.md/docs/02 §4 — and no clarification handler resolves gaps either; that link is separate,
 * real future work, not something this handler retrofits).
 */
export class ResolvePlanningGapHandler implements CommandHandler<
  ResolvePlanningGapPayload,
  ResolvePlanningGapResultState
> {
  readonly commandName = 'ResolvePlanningGapCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'resolve-planning-gap';

  async execute(
    envelope: CommandEnvelope<ResolvePlanningGapPayload>,
    db: DbClient,
  ): Promise<CommandResult<ResolvePlanningGapResultState>> {
    const { projectId, assessmentId, gapId, resolution, expectedVersion } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<ResolvePlanningGapResultState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const rows = await tx.query<GapRow>(
        `SELECT pg.id, pg.severity, pg.resolved_at, pg.version
         FROM planning_gaps pg
         JOIN planning_readiness_assessments pra ON pg.assessment_id = pra.id
         WHERE pg.id = ? AND pg.assessment_id = ? AND pra.project_id = ?`,
        [gapId, assessmentId, projectId],
      );
      const gap = rows[0];
      if (!gap) {
        throw new CommandError({
          type: 'not-found',
          title: 'Planning gap not found',
          status: 404,
          detail: `Gap ${gapId} not found for assessment ${assessmentId} in project ${projectId}`,
          instance: envelope.correlationId,
        });
      }
      if (gap.resolved_at) {
        throw new CommandError({
          type: 'gap-already-resolved',
          title: 'Planning gap is already resolved',
          status: 409,
          detail: `Gap ${gapId} was already resolved`,
          instance: envelope.correlationId,
        });
      }
      assertVersion('planning_gaps', gapId, gap, expectedVersion);

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE planning_gaps SET resolution = ?, resolved_at = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [resolution, now, nextVersion(gap.version), now, gapId, expectedVersion],
      );
      if (affected === 0) {
        throw new OptimisticLockError('planning_gaps', gapId, expectedVersion, -1);
      }

      await insertHumanApproval(tx, {
        projectId,
        contextType: 'planning_gap_resolution',
        contextId: gapId,
        decision: 'approved',
        actor: envelope.actor.id,
        actorRole: envelope.actor.role,
        notes: resolution,
      });
      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'planning_gap.resolved',
        fromState: gap.severity,
        toState: 'resolved',
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'planning_gap.resolved',
        payload: { projectId, assessmentId, gapId, resolution },
      });

      const result: CommandResult<ResolvePlanningGapResultState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: 'resolved',
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
