import { z } from 'zod';
import { FeatureExecutionState, FeatureKind, UserRole } from '../../../domain/states.js';
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

const ImportedFeatureSchema = z.object({
  frId: z.string().regex(/^FR-\d+$/),
  title: z.string(),
  description: z.string(),
  kind: z.enum([FeatureKind.FEATURE, FeatureKind.DISCOVERY]).default(FeatureKind.FEATURE),
  priority: z.number().int().default(0),
  dependsOnFrIds: z.array(z.string()).default([]),
});

export const ImportBacklogPayloadSchema = z.object({
  projectId: z.string(),
  planId: z.string(),
  features: z.array(ImportedFeatureSchema).min(1),
  /** Preview only — validates and reports what would be imported, without writing. */
  dryRun: z.boolean().default(false),
});
export type ImportBacklogPayload = z.infer<typeof ImportBacklogPayloadSchema>;

export type ImportBacklogResultState = 'previewed' | 'imported';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * parse -> validate -> preview -> approve -> transactional import (docs/02 §11). Parsing an
 * external plan.md/backlog.md into `features` happens upstream of this command (the command never
 * reads Markdown as runtime state); this command only validates the already-parsed structure and,
 * unless `dryRun`, performs the transactional import plus a human_approvals record for the import
 * decision.
 */
export class ImportBacklogHandler implements CommandHandler<
  ImportBacklogPayload,
  ImportBacklogResultState
> {
  readonly commandName = 'ImportBacklogCommand';
  readonly requiredRole = UserRole.APPROVER;
  readonly requiredActorKind = 'human' as const;
  readonly idempotencyScope = 'import-backlog';

  async execute(
    envelope: CommandEnvelope<ImportBacklogPayload>,
    db: DbClient,
  ): Promise<CommandResult<ImportBacklogResultState>> {
    const { projectId, planId, features, dryRun } = envelope.payload;

    // Post-merge review fix (MEDIUM-1): all validation — including target existence — must happen
    // before the dry-run preview returns, not just before the real import. `dryRun` previously
    // returned `previewed` right after the structural (duplicate/dependency) checks below, with
    // the plan/project existence check reachable only on the non-dry-run path further down — so a
    // preview against a nonexistent plan/project reported a false-positive "previewed" success,
    // only to fail with `not-found` on the real import after an operator had already approved the
    // (never-actually-valid) preview. `parse -> validate -> preview -> approve -> transactional
    // import` (docs/02 §11) requires the preview step to be a genuine validation gate.
    const duplicateFrIds = features
      .map((f) => f.frId)
      .filter((frId, index, all) => all.indexOf(frId) !== index);
    if (duplicateFrIds.length > 0) {
      throw new CommandError({
        type: 'duplicate-fr-id',
        title: 'Duplicate feature id in import payload',
        status: 400,
        detail: `Duplicate fr_id(s) in import payload: ${[...new Set(duplicateFrIds)].join(', ')}`,
        instance: envelope.correlationId,
      });
    }

    const frIds = new Set(features.map((f) => f.frId));
    for (const feature of features) {
      for (const dep of feature.dependsOnFrIds) {
        if (!frIds.has(dep)) {
          throw new CommandError({
            type: 'unknown-dependency',
            title: 'Unknown feature dependency in import payload',
            status: 400,
            detail: `Feature ${feature.frId} depends on unknown fr_id "${dep}"`,
            instance: envelope.correlationId,
          });
        }
      }
    }

    const planRows = await db.query<{ id: string }>(
      `SELECT id FROM implementation_plans WHERE id = ? AND project_id = ?`,
      [planId, projectId],
    );
    if (!planRows[0]) {
      throw new CommandError({
        type: 'not-found',
        title: 'Implementation plan not found',
        status: 404,
        detail: `Plan ${planId} not found in project ${projectId}`,
        instance: envelope.correlationId,
      });
    }

    if (dryRun) {
      return {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: 'previewed',
        emittedEventIds: [],
      };
    }

    return db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey<ImportBacklogResultState>(
        tx,
        envelope.idempotencyKey,
        this.idempotencyScope,
        IDEMPOTENCY_TTL_MS,
      );
      if (!claim.owned) return claim.result;

      const planRows = await tx.query<{ id: string }>(
        `SELECT id FROM implementation_plans WHERE id = ? AND project_id = ?`,
        [planId, projectId],
      );
      if (!planRows[0]) {
        throw new CommandError({
          type: 'not-found',
          title: 'Implementation plan not found',
          status: 404,
          detail: `Plan ${planId} not found in project ${projectId}`,
          instance: envelope.correlationId,
        });
      }

      const now = isoNow();
      const idByFrId = new Map<string, string>();
      for (const feature of features) {
        const id = generateId();
        idByFrId.set(feature.frId, id);
        await tx.execute(
          `INSERT INTO feature_requests
             (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            id,
            planId,
            projectId,
            feature.frId,
            feature.title,
            feature.description,
            feature.kind,
            feature.kind === FeatureKind.FEATURE ? 1 : 0,
            FeatureExecutionState.APPROVED_PENDING_EXECUTION,
            feature.priority,
            now,
            now,
          ],
        );
      }
      for (const feature of features) {
        const sourceId = idByFrId.get(feature.frId)!;
        for (const targetFrId of feature.dependsOnFrIds) {
          await tx.execute(
            `INSERT INTO feature_dependencies (id, source_fr_id, target_fr_id, created_at) VALUES (?, ?, ?, ?)`,
            [generateId(), sourceId, idByFrId.get(targetFrId)!, now],
          );
        }
      }

      await tx.execute(
        `INSERT INTO human_approvals (id, project_id, context_type, context_id, decision, actor, actor_role, version, created_at, updated_at)
         VALUES (?, ?, 'backlog_import', ?, 'approved', ?, ?, 1, ?, ?)`,
        [generateId(), projectId, planId, envelope.actor.id, envelope.actor.role, now, now],
      );

      // A backlog change invalidates any prior ValidateBacklogCommand result — see
      // GenerateFeatureBacklogHandler for the same pattern.
      await tx.execute(
        `UPDATE implementation_plans
         SET backlog_version = backlog_version + 1, backlog_validated_at = NULL,
             backlog_validated_state = NULL, backlog_validated_version = NULL, updated_at = ?
         WHERE id = ?`,
        [now, planId],
      );

      const eventId = await writeWorkflowEvent(tx, {
        projectId,
        eventType: 'backlog.imported',
        fromState: 'none',
        toState: 'imported',
        actorId: envelope.actor.id,
        correlationId: envelope.correlationId,
      });
      await writeOutboxEvent(tx, {
        eventType: 'backlog.imported',
        payload: { projectId, planId, featureCount: features.length },
      });

      const result: CommandResult<ImportBacklogResultState> = {
        commandId: envelope.commandId,
        accepted: true,
        resultingState: 'imported',
        emittedEventIds: [eventId],
      };
      await fulfillIdempotencyKey(tx, claim.claimId, result);
      return result;
    });
  }
}
