import { z } from 'zod';
import { AgentRole, ClarificationStatus, ReadinessStatus, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { CLARIFICATION_MATRIX } from '../../../statemachine/machines/clarification.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import type { AdapterRegistry } from '../../../adapters/registry.js';
import type { AgentRunRecorder } from '../../../adapters/run-recorder.js';
import type { PlannerAgentAdapter } from '../../../adapters/types.js';
import {
  isoNow,
  generateId,
  writeWorkflowEvent,
  writeOutboxEvent,
  claimIdempotencyKey,
  fulfillIdempotencyKey,
} from '../../helpers.js';

export const AssessPlanningReadinessPayloadSchema = z.object({
  projectId: z.string(),
  specificationInputId: z.string().nullable().optional(),
  specificationContent: z.string(),
});
export type AssessPlanningReadinessPayload = z.infer<typeof AssessPlanningReadinessPayloadSchema>;

const clarificationValidator = new StateTransitionValidator(CLARIFICATION_MATRIX, 'clarification');
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Invokes PlannerAgentAdapter (via AgentRunRecorder for provenance/audit) to assess whether the
 * specification is sufficient, then writes planning_readiness_assessments + planning_gaps +
 * planning_questions + planning_assumptions, and creates the project's clarification_sessions
 * row (docs/02-bootstrap-planner-clarification.md §3-4).
 *
 * Session genesis is an INSERT, not a matrix transition — like implementation_plans starting at
 * `draft` with no incoming matrix row. For a sufficient/sufficient_with_assumptions result, the
 * session is inserted at clarification_not_required and immediately advanced to
 * clarification_complete through CLARIFICATION_MATRIX in the same transaction (every other status
 * change in this codebase goes through StateTransitionValidator).
 *
 * The adapter call happens outside the DB transaction because AgentRunRecorder performs its own
 * non-transactional agent_runs bookkeeping (queued -> running -> succeeded|failed); a retry that
 * hits the idempotency cache after the domain write already committed will still re-invoke the
 * adapter, producing an extra (but harmless) agent_runs audit row.
 */
export class AssessPlanningReadinessHandler
  implements CommandHandler<AssessPlanningReadinessPayload, ReadinessStatus>
{
  readonly commandName = 'AssessPlanningReadinessCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'assess-planning-readiness';

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly recorder: AgentRunRecorder,
    private readonly planner: PlannerAgentAdapter,
    private readonly plannerAdapterName: string,
  ) {}

  async execute(
    envelope: CommandEnvelope<AssessPlanningReadinessPayload>,
    db: DbClient,
  ): Promise<CommandResult<ReadinessStatus>> {
    const { projectId, specificationInputId, specificationContent } = envelope.payload;

    const adapterRecord = await this.registry.resolve(AgentRole.PLANNER, this.plannerAdapterName);
    const { output } = await this.recorder.record(
      {
        adapterId: adapterRecord.id,
        role: AgentRole.PLANNER,
        projectId,
        input: { projectId, specificationContent, correlationId: envelope.correlationId },
        capabilitiesUsed: ['can_generate_plan'],
      },
      () =>
        this.planner.run({
          projectId,
          specificationContent,
          correlationId: envelope.correlationId,
        }),
    );

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<ReadinessStatus>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const now = isoNow();
      const assessmentId = generateId();
      await tx.execute(
        `INSERT INTO planning_readiness_assessments
           (id, project_id, specification_input_id, status, summary, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
        [assessmentId, projectId, specificationInputId ?? null, output.readinessResult, now, now],
      );

      for (const gap of output.gaps) {
        await tx.execute(
          `INSERT INTO planning_gaps
             (id, assessment_id, description, severity, resolution, resolved_at, clarification_session_id, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?)`,
          [generateId(), assessmentId, gap.description, gap.severity, now, now],
        );
      }
      for (const question of output.questions) {
        await tx.execute(
          `INSERT INTO planning_questions
             (id, assessment_id, question, answer, answered_at, round, version, created_at, updated_at)
           VALUES (?, ?, ?, NULL, NULL, ?, 1, ?, ?)`,
          [generateId(), assessmentId, question.question, question.round, now, now],
        );
      }
      for (const assumption of output.assumptions) {
        await tx.execute(
          `INSERT INTO planning_assumptions
             (id, assessment_id, description, confidence, clarification_session_id, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, 1, ?, ?)`,
          [generateId(), assessmentId, assumption.description, assumption.confidence, now, now],
        );
      }

      const clarificationSessionId = generateId();
      let clarificationStatus: ClarificationStatus;
      if (output.readinessResult === ReadinessStatus.INSUFFICIENT) {
        clarificationStatus = ClarificationStatus.REQUIRED;
        await tx.execute(
          `INSERT INTO clarification_sessions
             (id, project_id, specification_input_id, status, round, max_rounds, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 3, 1, ?, ?)`,
          [clarificationSessionId, projectId, specificationInputId ?? null, clarificationStatus, now, now],
        );
      } else {
        await tx.execute(
          `INSERT INTO clarification_sessions
             (id, project_id, specification_input_id, status, round, max_rounds, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 3, 1, ?, ?)`,
          [clarificationSessionId, projectId, specificationInputId ?? null, ClarificationStatus.NOT_REQUIRED, now, now],
        );
        clarificationValidator.assertValid(ClarificationStatus.NOT_REQUIRED, ClarificationStatus.COMPLETE);
        await tx.executeAffected(
          `UPDATE clarification_sessions SET status = ?, version = 2, updated_at = ? WHERE id = ?`,
          [ClarificationStatus.COMPLETE, now, clarificationSessionId],
        );
        clarificationStatus = ClarificationStatus.COMPLETE;
      }

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'planning_readiness.assessed',
        fromState: 'none',
        toState: output.readinessResult,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'planning_readiness.assessed',
        payload: {
          projectId,
          assessmentId,
          readinessResult: output.readinessResult,
          clarificationSessionId,
          clarificationStatus,
        },
      });

      const result: CommandResult<ReadinessStatus> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: output.readinessResult,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
