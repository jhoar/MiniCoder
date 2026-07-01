import { z } from 'zod';
import { FeatureKind, UserRole } from '../../../domain/states.js';
import { CommandError } from '../../types.js';
import type { CommandHandler, CommandEnvelope, CommandResult } from '../../types.js';
import type { DbClient } from '../../../persistence/types.js';
import { writeWorkflowEvent, writeOutboxEvent, claimIdempotencyKey, fulfillIdempotencyKey } from '../../helpers.js';

export const ValidateBacklogPayloadSchema = z.object({
  projectId: z.string(),
  planId: z.string(),
});
export type ValidateBacklogPayload = z.infer<typeof ValidateBacklogPayloadSchema>;

export type ValidateBacklogResultState = 'valid' | 'invalid';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface FeatureRow {
  id: string;
  fr_id: string;
  kind: string;
}

interface DependencyRow {
  source_fr_id: string;
  target_fr_id: string;
}

function hasCycle(features: readonly FeatureRow[], deps: readonly DependencyRow[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const dep of deps) {
    const list = adjacency.get(dep.source_fr_id) ?? [];
    list.push(dep.target_fr_id);
    adjacency.set(dep.source_fr_id, list);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(features.map((f) => [f.id, WHITE]));

  function visit(id: string): boolean {
    color.set(id, GRAY);
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && visit(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  }

  for (const feature of features) {
    if (color.get(feature.id) === WHITE && visit(feature.id)) return true;
  }
  return false;
}

/**
 * Backlog quality gate (docs/02 §9): no cycles in feature_dependencies; every kind='feature' row
 * has at least one acceptance criterion and one test expectation. Writes a workflow_events row
 * recording the outcome; never mutates plan/feature state itself.
 */
export class ValidateBacklogHandler
  implements CommandHandler<ValidateBacklogPayload, ValidateBacklogResultState>
{
  readonly commandName = 'ValidateBacklogCommand';
  readonly requiredRole = UserRole.ADMIN;
  readonly requiredActorKind = 'system' as const;
  readonly idempotencyScope = 'validate-backlog';

  async execute(
    envelope: CommandEnvelope<ValidateBacklogPayload>,
    db: DbClient,
  ): Promise<CommandResult<ValidateBacklogResultState>> {
    const { projectId, planId } = envelope.payload;

    // The transaction always commits — even an 'invalid' outcome must persist its workflow_event
    // and idempotency record — so the CommandError below is thrown after the transaction
    // resolves, not inside it (throwing inside would roll back the recorded outcome).
    const result = await db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<ValidateBacklogResultState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return { txResult: claim.result, problems: [] as string[] };

      const features = await tx.query<FeatureRow>(
        `SELECT id, fr_id, kind FROM feature_requests WHERE plan_id = ? AND project_id = ?`,
        [planId, projectId],
      );
      if (features.length === 0) {
        throw new CommandError({
          type: 'empty-backlog',
          title: 'Backlog is empty',
          status: 409,
          detail: `Plan ${planId} has no feature requests to validate`,
          instance: envelope.correlationId,
        });
      }

      const deps = await tx.query<DependencyRow>(
        `SELECT fd.source_fr_id, fd.target_fr_id FROM feature_dependencies fd
         JOIN feature_requests fr ON fd.source_fr_id = fr.id
         WHERE fr.plan_id = ?`,
        [planId],
      );

      const problems: string[] = [];
      if (hasCycle(features, deps)) {
        problems.push('feature_dependencies contains a cycle');
      }

      const executableIds = features.filter((f) => f.kind === FeatureKind.FEATURE).map((f) => f.id);
      if (executableIds.length > 0) {
        const placeholders = executableIds.map(() => '?').join(', ');
        const acRows = await tx.query<{ feature_request_id: string }>(
          `SELECT DISTINCT feature_request_id FROM acceptance_criteria WHERE feature_request_id IN (${placeholders})`,
          executableIds,
        );
        const teRows = await tx.query<{ feature_request_id: string }>(
          `SELECT DISTINCT feature_request_id FROM test_expectations WHERE feature_request_id IN (${placeholders})`,
          executableIds,
        );
        const withAc = new Set(acRows.map((r) => r.feature_request_id));
        const withTe = new Set(teRows.map((r) => r.feature_request_id));
        for (const feature of features) {
          if (feature.kind !== FeatureKind.FEATURE) continue;
          if (!withAc.has(feature.id)) {
            problems.push(`${feature.fr_id} has no acceptance criteria`);
          }
          if (!withTe.has(feature.id)) {
            problems.push(`${feature.fr_id} has no test expectations`);
          }
        }
      }

      const resultingState: ValidateBacklogResultState = problems.length === 0 ? 'valid' : 'invalid';

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'backlog.validated',
        fromState: 'generated',
        toState: resultingState,
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'backlog.validated',
        payload: { projectId, planId, resultingState, problems },
      });

      const txResult: CommandResult<ValidateBacklogResultState> = {
        commandId: envelope.commandId,
        accepted: resultingState === 'valid',
        resultingState,
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, txResult);
      return { txResult, problems };
    });

    if (result.txResult.resultingState === 'invalid') {
      throw new CommandError({
        type: 'backlog-invalid',
        title: 'Backlog failed quality validation',
        status: 422,
        detail: result.problems.join('; '),
        instance: envelope.correlationId,
      });
    }
    return result.txResult;
  }
}
