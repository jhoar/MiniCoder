import { z } from 'zod';
import { ProjectState, UserRole } from '../../../domain/states.js';
import { StateTransitionValidator } from '../../../statemachine/validator.js';
import { PROJECT_LIFECYCLE_MATRIX } from '../../../statemachine/machines/project-lifecycle.js';
import { assertVersion, nextVersion } from '../../../persistence/optimistic.js';
import { OptimisticLockError, SerializationFailureError } from '../../../persistence/types.js';
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
/** Bounded retry count for a `SERIALIZABLE`-isolation conflict (PostgreSQL SQLSTATE `40001`) — a
 * rare event even under real contention, so a small bound is enough; each retry re-runs the whole
 * transaction function from scratch against fresh state. */
const MAX_SERIALIZATION_RETRIES = 3;

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
 *
 * Evaluating acceptance inside the transaction narrows the stale-read window but does not, by
 * itself, close it under ordinary `READ COMMITTED` isolation (PostgreSQL's default): a concurrent
 * writer could still commit an acceptance-invalidating change (a new non-terminal feature run, an
 * unresolved blocking finding, a stuck outbox/inbox row, a failed artifact export) after the
 * `SELECT`-based `evaluateProjectAcceptance()` reads but before this handler's own `UPDATE`
 * commits (PR review finding). Fixed by making the terminal `UPDATE` itself carry the same
 * acceptance predicate as `NOT EXISTS` guards in its `WHERE` clause — the same "guarded update
 * instead of relying on isolation level" pattern `StartCodingHandler`'s `AND EXISTS (SELECT 1
 * FROM workflow_states WHERE automation_state = 'running')` guard already establishes elsewhere
 * in this codebase. A 0-affected-row result is disambiguated the same two-step way
 * `SelectFeatureHandler` already does for its own compare-and-swap: re-check whether the version
 * changed (a genuine `OptimisticLockError`) or the acceptance predicate itself changed underneath
 * (re-run `evaluateProjectAcceptance()` for a clear `project-acceptance-failed` message). The
 * `SELECT`-based `evaluateProjectAcceptance()` call above stays — it is what produces a fast,
 * readable rejection message on the common "acceptance already fails" path — but it is no longer
 * the sole enforcement of the predicate; the guarded `UPDATE` is.
 *
 * The guarded `UPDATE` closes the "stale read before the update statement" case, but under plain
 * PostgreSQL `READ COMMITTED` it does not, by itself, keep the acceptance predicate stable through
 * to `COMMIT`: a fully independent concurrent transaction committing an acceptance-invalidating
 * write (to `feature_runs`/`review_findings`/`outbox_events`/`inbox_events`/`artifact_exports`)
 * in the window between this transaction's `UPDATE` and its own `COMMIT` is not blocked by
 * anything the guarded `UPDATE` does (PR review finding — a materially deeper point than the
 * "stale read" case the guarded `UPDATE` above already fixes). Closed by running this entire
 * transaction at PostgreSQL `SERIALIZABLE` isolation (`TransactionOptions.isolationLevel`):
 * PostgreSQL's serializable-snapshot-isolation (SSI) machinery automatically detects a dangerous
 * read/write conflict against ANY concurrent transaction that touches rows this transaction read
 * (the acceptance-predicate tables) — no explicit lock, fence, or cooperation from those other
 * writers is required. A conflict surfaces as a `SerializationFailureError` at `COMMIT` (or,
 * occasionally, at an earlier statement); `execute()` retries the whole transaction function up
 * to `MAX_SERIALIZATION_RETRIES` times on that error, which is safe because a rolled-back
 * transaction leaves no partial state (including the `idempotency_keys` claim) for the retry to
 * collide with. On the SQLite persistence backend this isolation request is a documented no-op
 * (see `TransactionOptions`'s doc comment) — its single-writer model already provides the
 * equivalent guarantee, so no retry loop is ever actually exercised there.
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

    for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        return await this.runTransaction(
          envelope,
          db,
          projectId,
          expectedVersion,
          externalChecksEvidence,
        );
      } catch (err) {
        if (err instanceof SerializationFailureError && attempt < MAX_SERIALIZATION_RETRIES) {
          continue;
        }
        throw err;
      }
    }
    // Unreachable: the loop above always either returns or throws.
    throw new Error('unreachable');
  }

  private async runTransaction(
    envelope: CommandEnvelope<MarkImplementationCompletePayload>,
    db: DbClient,
    projectId: string,
    expectedVersion: number,
    externalChecksEvidence: string,
  ): Promise<CommandResult<ProjectState>> {
    return db.transaction(
      async (tx) => {
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
          `UPDATE projects SET state = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?
           AND NOT EXISTS (
             SELECT 1 FROM feature_requests freq
             LEFT JOIN feature_runs fr ON fr.feature_request_id = freq.id
             WHERE freq.project_id = ? AND freq.kind = 'feature'
               AND (fr.id IS NULL OR fr.current_execution_state NOT IN ('merged', 'skipped'))
           )
           AND NOT EXISTS (
             SELECT 1 FROM feature_runs fr
             JOIN feature_requests freq ON fr.feature_request_id = freq.id
             WHERE freq.project_id = ? AND fr.current_execution_state IN ('human_required', 'blocked')
           )
           AND NOT EXISTS (
             SELECT 1 FROM review_findings rf
             JOIN feature_runs fr ON rf.feature_run_id = fr.id
             JOIN feature_requests freq ON fr.feature_request_id = freq.id
             WHERE freq.project_id = ? AND rf.severity = 'blocking' AND rf.resolved = FALSE
           )
           AND NOT EXISTS (
             SELECT 1 FROM outbox_events WHERE status IN ('pending', 'processing') AND attempts >= 5
           )
           AND NOT EXISTS (
             SELECT 1 FROM inbox_events WHERE status IN ('pending', 'processing') AND attempts >= 5
           )
           AND NOT EXISTS (
             SELECT 1 FROM artifact_exports WHERE project_id = ? AND state = 'failed'
           )`,
          [
            ProjectState.IMPLEMENTATION_COMPLETE,
            nextVersion(project.version),
            now,
            projectId,
            expectedVersion,
            projectId,
            projectId,
            projectId,
            projectId,
          ],
        );
        if (affected === 0) {
          // Disambiguate: a stale version (a genuine optimistic-lock conflict) vs. an acceptance
          // predicate that changed underneath between the SELECT-based check above and this UPDATE
          // (the race this guard exists to close) — the same two-step pattern
          // `SelectFeatureHandler` already uses for its own compare-and-swap.
          const refreshed = await tx.query<ProjectRow>(
            `SELECT id, state, version FROM projects WHERE id = ?`,
            [projectId],
          );
          if (!refreshed[0] || refreshed[0].version !== expectedVersion) {
            throw new OptimisticLockError(
              'projects',
              projectId,
              expectedVersion,
              refreshed[0]?.version ?? -1,
            );
          }
          const recheck = await evaluateProjectAcceptance(tx, projectId);
          throw new CommandError({
            type: 'project-acceptance-failed',
            title: 'Project Acceptance Validation failed',
            status: 409,
            detail: `Project ${projectId} no longer passes Project Acceptance Validation (changed concurrently): ${recheck.checks
              .filter((c) => !c.passed)
              .map((c) => c.name)
              .join(', ')}`,
          });
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
      },
      { isolationLevel: 'serializable' },
    );
  }
}
