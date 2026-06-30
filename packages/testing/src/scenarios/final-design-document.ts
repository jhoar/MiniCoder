import type { Scenario, ScenarioContext } from './types.js';

export const finalDesignDocumentScenario: Scenario = {
  name: 'final-design-document',
  description: 'export-plan + export-backlog tasks, DocumentationAdapter, assert artifact exported',
  fixtureName: 'final-design-document',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner, documentation, storage } = ctx;

    // Run export-plan task
    await runner.run('export-plan', { projectId }, async (_payload: unknown) => {
      const result = await documentation.run({
        projectId,
        planId: `plan-${projectId}`,
        featureCount: 0,
        correlationId: `corr-export-plan-${projectId}`,
      });

      const content = result.sections
        .map((s) => `## ${s.sectionName}\n\n${s.content}`)
        .join('\n\n');

      storage.store(`plan-${projectId}`, content);

      await db.execute(
        `UPDATE artifact_exports
           SET state = 'exported', content = ?, exported_at = datetime('now'), updated_at = datetime('now')
           WHERE project_id = ? AND artifact_type = 'plan'`,
        [content, projectId],
      );

      return result;
    });

    // Run export-backlog task
    await runner.run('export-backlog', { projectId }, async (_payload: unknown) => {
      const result = await documentation.run({
        projectId,
        planId: `plan-${projectId}`,
        featureCount: 0,
        correlationId: `corr-export-backlog-${projectId}`,
      });

      const content = result.sections
        .map((s) => `## ${s.sectionName}\n\n${s.content}`)
        .join('\n\n');

      storage.store(`backlog-${projectId}`, content);

      await db.execute(
        `UPDATE artifact_exports
           SET state = 'exported', content = ?, exported_at = datetime('now'), updated_at = datetime('now')
           WHERE project_id = ? AND artifact_type = 'backlog'`,
        [content, projectId],
      );

      return result;
    });

    // Assert both artifacts are exported
    const exports = await db.query<{ artifact_type: string; state: string }>(
      `SELECT artifact_type, state FROM artifact_exports WHERE project_id = ?`,
      [projectId],
    );

    if (exports.length !== 2) {
      throw new Error(`Expected 2 artifact exports, found ${exports.length}`);
    }

    const notExported = exports.filter(
      (e: { artifact_type: string; state: string }) => e.state !== 'exported',
    );
    if (notExported.length > 0) {
      throw new Error(
        `Expected all artifacts exported, but ${notExported.map((e: { artifact_type: string; state: string }) => e.artifact_type).join(', ')} not exported`,
      );
    }

    if (!storage.has(`plan-${projectId}`)) {
      throw new Error('Expected plan artifact to be stored in artifact storage');
    }

    if (!storage.has(`backlog-${projectId}`)) {
      throw new Error('Expected backlog artifact to be stored in artifact storage');
    }

    if (documentation.calls.length !== 2) {
      throw new Error(`Expected 2 documentation adapter calls, got ${documentation.calls.length}`);
    }
  },
};
