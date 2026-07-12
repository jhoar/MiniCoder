import { z } from 'zod';
import { ProjectState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { PROJECT_LIFECYCLE_MATRIX } from '../../../statemachine/machines/project-lifecycle.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import { OptimisticLockError } from '../../../persistence/types.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import { CommandError } from '../../types.js';
import {
  isoNow,
  writeWorkflowEvent,
  writeOutboxEvent,
  claimIdempotencyKey,
  fulfillIdempotencyKey,
  insertHumanApproval,
} from '../../helpers.js';
import { evaluateProjectAcceptance } from '../../../project/acceptance.js';

export const MarkImplementationCompletePayloadSchema = z.object({
  projectId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  /** Caller-attested confirmation that the CI-only checks `evaluateProjectAcceptance()`
   * structurally cannot verify from the database (full test suite, migration validation, build,
   * lint/typecheck, security scan — see its `externalChecksNotVerified` field) have already
   * passed out-of-band — e.g. a CI run URL or an operator's sign-off note. Required and persisted
   * as a `human_approvals` audit row: an explicit, audited attestation, not a silent assumption
   * that "the DB-knowable checks passed" means "the CI-only checks passed too." */
  externalChecksEvidence: z.string().min(1),
});
export type MarkImplementationCompletePayload = z.infer<
  typeof MarkImplementationCompletePayloadSchema
>;

const validator = new StateTransitionValidator(PROJECT_LIFECYCLE_MATRIX, 'project-lifecycle');
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface ProjectRow {
  id: string;
  state: string;
  version: number;
}

/**
 * `active -> implementation_complete` (system actor, per the glossary's Project lifecycle
 * matrix). The guard is "all approved feature requests in merged state; Project Acceptance
 * Validation passes" — enforced via two complementary checks, both run INSIDE the same
 * transaction that performs the state update (not before it opens): `evaluateProjectAcceptance()`
 * re-evaluated against `tx` (not a pre-transaction `db` read) so a concurrent write to a feature
 * run/review finding/outbox row between the check and the state mutation can't slip through a
 * stale "passed" verdict, and a required, caller-supplied `externalChecksEvidence` attestation
 * (persisted as a `human_approvals` audit row) for the CI-only checks
 * `evaluateProjectAcceptance()` structurally cannot itself verify from the database (see that
 * module's doc comment) — this command no longer silently treats "every DB-knowable check passed"
 * as if it also meant "the CI-only checks passed."
 */
export class MarkImplementationCompleteHandler implements CommandHandler<
  MarkImplementationCompletePayload,
  ProjectState
> {
  readonly commandName = 'MarkImplementationCompleteCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'mark-implementation-complete';

  async execute(
    envelope: CommandEnvelope<MarkImplementationCompletePayload>,
    db: DbClient,
  ): Promise<CommandResult<ProjectState>> {
    const { projectId, expectedVersion, externalChecksEvidence } = envelope.payload;
    if (!externalChecksEvidence || externalChecksEvidence.trim().length === 0) {
      throw new CommandError({
        type: 'external-checks-evidence-required',
        title: 'External Project Acceptance evidence required',
        status: 400,
        detail:
          'externalChecksEvidence must attest that the CI-only checks (full test suite, ' +
          'migration validation, build, lint/typecheck, security scan) have already passed ' +
          'out-of-band — e.g. a CI run URL or an operator sign-off note.',
      });
    }

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<ProjectState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const acceptance = await evaluateProjectAcceptance(tx, projectId);
      if (!acceptance.passed) {
        throw new CommandError({
          type: 'project-acceptance-failed',
          title: 'Project Acceptance Validation failed',
          status: 409,
          detail: `Project ${projectId} does not pass Project Acceptance Validation: ${acceptance.checks
            .filter((c) => !c.passed)
            .map((c) => c.name)
            .join(', ')}`,
        });
      }

      const rows = await tx.query<ProjectRow>(
        `SELECT id, state, version FROM projects WHERE id = ?`,
        [projectId],
      );
      const project = rows[0];
      if (!project) {
        throw new CommandError({
          type: 'not-found',
          title: 'Project not found',
          status: 404,
          detail: `Project ${projectId} not found`,
        });
      }
      assertVersion('projects', projectId, project, expectedVersion);
      validator.assertValid(project.state as ProjectState, ProjectState.IMPLEMENTATION_COMPLETE);

      const now = isoNow();
      const affected = await tx.executeAffected(
        `UPDATE projects SET state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
        [
          ProjectState.IMPLEMENTATION_COMPLETE,
          nextVersion(project.version),
          now,
          projectId,
          expectedVersion,
        ],
      );
      if (affected === 0) {
        throw new OptimisticLockError('projects', projectId, expectedVersion, -1);
      }

      await insertHumanApproval(tx, {
        projectId,
        contextType: 'project_acceptance_external_checks',
        decision: 'approved',
        actor: envelope.actor.id,
        actorRole: envelope.actor.role,
        notes: externalChecksEvidence,
      });

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'project.implementation_complete',
        fromState: ProjectState.ACTIVE,
        toState: ProjectState.IMPLEMENTATION_COMPLETE,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'project.implementation_complete',
        payload: { projectId },
      });

      const result: CommandResult<ProjectState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: ProjectState.IMPLEMENTATION_COMPLETE,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
