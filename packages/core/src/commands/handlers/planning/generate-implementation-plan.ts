import { z } from 'zod';
import { ClarificationStatus, PlanState, ReadinessStatus, UserRole } from '../../../domain/states.js';
import { CommandError } from '../../types.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import {
  isoNow,
  generateId,
  writeWorkflowEvent,
  writeOutboxEvent,
  claimIdempotencyKey,
  fulfillIdempotencyKey,
} from '../../helpers.js';

export const GenerateImplementationPlanPayloadSchema = z.object({
  projectId: z.string(),
  assessmentId: z.string(),
  title: z.string(),
  summary: z.string().nullable().optional(),
  sections: z.array(
    z.object({
      title: z.string(),
      content: z.string(),
    }),
  ),
});
export type GenerateImplementationPlanPayload = z.infer<typeof GenerateImplementationPlanPayloadSchema>;

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface AssessmentRow {
  status: string;
}

/**
 * Writes implementation_plans (state=draft) + plan_sections from already-structured plan content.
 * PlannerAgentAdapter's output contract (docs/03) covers readiness assessment only (readinessResult
 * / questions / assumptions / gaps) — it does not yet define a plan-content-generation shape, so
 * plan section content is caller-supplied here rather than invented ad hoc. Deeper
 * planner-generated plan content is a Phase 9+ adapter-contract concern.
 *
 * Guard: the readiness assessment must be sufficient or sufficient_with_assumptions, and
 * clarification must not still be open (clarification_not_required or clarification_complete).
 */
export class GenerateImplementationPlanHandler
  implements CommandHandler<GenerateImplementationPlanPayload, PlanState>
{
  readonly commandName = 'GenerateImplementationPlanCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'generate-implementation-plan';

  async execute(
    envelope: CommandEnvelope<GenerateImplementationPlanPayload>,
    db: DbClient,
  ): Promise<CommandResult<PlanState>> {
    const { projectId, assessmentId, title, summary, sections } = envelope.payload;

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<PlanState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const assessmentRows = await tx.query<AssessmentRow>(
        `SELECT status FROM planning_readiness_assessments WHERE id = ? AND project_id = ?`,
        [assessmentId, projectId],
      );
      const assessment = assessmentRows[0];
      if (!assessment) {
        throw new CommandError({
          type: 'not-found',
          title: 'Planning readiness assessment not found',
          status: 404,
          detail: `Assessment ${assessmentId} not found in project ${projectId}`,
          instance: envelope.correlationId,
        });
      }
      if (
        assessment.status !== ReadinessStatus.SUFFICIENT &&
        assessment.status !== ReadinessStatus.SUFFICIENT_WITH_ASSUMPTIONS
      ) {
        throw new CommandError({
          type: 'not-ready',
          title: 'Readiness assessment is not sufficient',
          status: 409,
          detail: `Assessment ${assessmentId} has status "${assessment.status}"`,
          instance: envelope.correlationId,
        });
      }

      // Scoped to the assessment being used, not "the project's most recent clarification
      // session" — a project can have multiple assessments over time, each with its own session.
      const sessionRows = await tx.query<{ status: string }>(
        `SELECT status FROM clarification_sessions WHERE assessment_id = ? ORDER BY created_at DESC LIMIT 1`,
        [assessmentId],
      );
      const session = sessionRows[0];
      if (
        session &&
        session.status !== ClarificationStatus.NOT_REQUIRED &&
        session.status !== ClarificationStatus.COMPLETE
      ) {
        throw new CommandError({
          type: 'clarification-open',
          title: 'Clarification is not complete',
          status: 409,
          detail: `Clarification session for project ${projectId} has status "${session.status}"`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      const planId = generateId();
      await tx.execute(
        `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [planId, projectId, assessmentId, PlanState.DRAFT, title, summary ?? null, now, now],
      );

      for (let i = 0; i < sections.length; i++) {
        const section = sections[i]!;
        await tx.execute(
          `INSERT INTO plan_sections (id, plan_id, title, content, order_index, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          [generateId(), planId, section.title, section.content, i, now, now],
        );
      }

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'plan.generated',
        fromState: 'none',
        toState: PlanState.DRAFT,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'plan.generated',
        payload: { projectId, planId, assessmentId },
      });

      const result: CommandResult<PlanState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: PlanState.DRAFT,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
