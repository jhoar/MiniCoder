import { describe, it, expect } from 'vitest';
import {
  ExportBacklogHandler,
  ImportBacklogHandler,
  TransactionalCommandExecutor,
  parseBacklogMarkdown,
  generateId,
} from '@minicoder/core';
import type { ActorIdentity, CommandEnvelope, DbClient } from '@minicoder/core';
import { createTestDb } from './db.js';

/**
 * Issue #33: round-trip coverage for `parseBacklogMarkdown()` against the real
 * `ExportBacklogHandler`/`ImportBacklogHandler` pair, not just hand-built Markdown fixtures.
 * Confirms export -> parse -> re-import reproduces every feature's title/description/kind, and
 * documents (rather than silently losing) the two real format limitations: `priority` is
 * reconstructed from document order, not the original numeric value, and `dependsOnFrIds` is
 * always empty, since `ExportBacklogHandler`'s Markdown carries neither.
 */

const PROJECT_ID = 'proj-backlog-roundtrip';

function operatorActor(correlationId: string): ActorIdentity {
  return { id: 'test-operator', role: 'operator', actorKind: 'human', correlationId };
}
function approverActor(correlationId: string): ActorIdentity {
  return { id: 'test-approver', role: 'approver', actorKind: 'human', correlationId };
}

async function seedPlanWithFeatures(
  db: DbClient,
  planId: string,
  features: Array<{
    frId: string;
    title: string;
    description: string;
    kind: string;
    priority: number;
  }>,
): Promise<void> {
  await db.execute(
    `INSERT OR IGNORE INTO projects (id, name, state, version, created_at, updated_at)
     VALUES (?, 'Backlog Roundtrip Project', 'active', 1, datetime('now'), datetime('now'))`,
    [PROJECT_ID],
  );
  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
    [planId, PROJECT_ID],
  );
  for (const f of features) {
    await db.execute(
      `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'approved_pending_execution', ?, 1, datetime('now'), datetime('now'))`,
      [generateId(), planId, PROJECT_ID, f.frId, f.title, f.description, f.kind, f.priority],
    );
  }
}

describe('backlog.md round trip (issue #33)', () => {
  it('export -> parse -> re-import reproduces title/description/kind for every feature', async () => {
    const db = createTestDb();
    const sourcePlanId = 'plan-backlog-roundtrip-source';
    const correlationId = 'corr-backlog-roundtrip';

    const originalFeatures = [
      {
        frId: 'FR-001',
        title: 'Add widget',
        description: 'A single-line description.',
        kind: 'feature',
        priority: 0,
      },
      {
        frId: 'FR-002',
        title: 'Explore integration options',
        description: 'First paragraph.\n\nSecond paragraph.',
        kind: 'discovery',
        priority: 5,
      },
      {
        frId: 'FR-003',
        title: 'Add gadget',
        description: 'Another description.',
        kind: 'feature',
        priority: 10,
      },
    ];
    await seedPlanWithFeatures(db, sourcePlanId, originalFeatures);

    const exportExecutor = new TransactionalCommandExecutor(db);
    const exportEnvelope: CommandEnvelope<{ projectId: string; planId: string }> = {
      commandId: generateId(),
      idempotencyKey: `export-backlog:${sourcePlanId}`,
      payload: { projectId: PROJECT_ID, planId: sourcePlanId },
      actor: operatorActor(correlationId),
      correlationId,
    };
    await exportExecutor.execute(new ExportBacklogHandler(), exportEnvelope);

    const exportRows = await db.query<{ content: string }>(
      `SELECT content FROM artifact_exports WHERE project_id = ? AND artifact_type = 'backlog' ORDER BY created_at DESC LIMIT 1`,
      [PROJECT_ID],
    );
    const markdown = exportRows[0]?.content;
    expect(markdown).toBeTruthy();

    const parsed = parseBacklogMarkdown(markdown!);
    expect(parsed.map((f) => f.frId)).toEqual(['FR-001', 'FR-002', 'FR-003']);
    expect(parsed.map((f) => f.title)).toEqual(originalFeatures.map((f) => f.title));
    expect(parsed.map((f) => f.description)).toEqual(originalFeatures.map((f) => f.description));
    expect(parsed.map((f) => f.kind)).toEqual(originalFeatures.map((f) => f.kind));
    // Format limitation, documented not silently lost: priority is reconstructed from document
    // order (0, 1, 2, ...), not the original numeric priority (0, 5, 10).
    expect(parsed.map((f) => f.priority)).toEqual([0, 1, 2]);
    expect(parsed.every((f) => f.dependsOnFrIds.length === 0)).toBe(true);

    // Re-import into a fresh project+plan (feature_requests.fr_id is unique per project, so
    // reusing the source project would collide with the rows already seeded there) and confirm
    // the imported rows match the original attributes.
    const targetProjectId = 'proj-backlog-roundtrip-target';
    const targetPlanId = 'plan-backlog-roundtrip-target';
    await db.execute(
      `INSERT INTO projects (id, name, state, version, created_at, updated_at)
       VALUES (?, 'Backlog Roundtrip Target Project', 'active', 1, datetime('now'), datetime('now'))`,
      [targetProjectId],
    );
    await db.execute(
      `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Target Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
      [targetPlanId, targetProjectId],
    );

    const importExecutor = new TransactionalCommandExecutor(db);
    const importEnvelope: CommandEnvelope<{
      projectId: string;
      planId: string;
      features: typeof parsed;
      dryRun: boolean;
    }> = {
      commandId: generateId(),
      idempotencyKey: `import-backlog:${targetPlanId}`,
      payload: {
        projectId: targetProjectId,
        planId: targetPlanId,
        features: parsed,
        dryRun: false,
      },
      actor: approverActor(correlationId),
      correlationId,
    };
    const importResult = await importExecutor.execute(new ImportBacklogHandler(), importEnvelope);
    expect(importResult.resultingState).toBe('imported');

    const importedRows = await db.query<{
      fr_id: string;
      title: string;
      description: string;
      kind: string;
    }>(
      `SELECT fr_id, title, description, kind FROM feature_requests WHERE plan_id = ? ORDER BY fr_id ASC`,
      [targetPlanId],
    );
    expect(importedRows).toEqual(
      originalFeatures.map((f) => ({
        fr_id: f.frId,
        title: f.title,
        description: f.description,
        kind: f.kind,
      })),
    );

    // The format carries no dependency information, so re-import always produces none — this is
    // the documented limitation, not an assertion that dependencies survive the round trip.
    const dependencyRows = await db.query<{ id: string }>(
      `SELECT fd.id FROM feature_dependencies fd
       JOIN feature_requests fr ON fr.id = fd.source_fr_id
       WHERE fr.plan_id = ?`,
      [targetPlanId],
    );
    expect(dependencyRows).toHaveLength(0);
  });
});
