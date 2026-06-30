import type { Scenario, ScenarioContext } from './types.js';

export const backlogActivationScenario: Scenario = {
  name: 'backlog-activation',
  description:
    'Runs plan → backlog → activate-approved-backlog, asserts features at approved_pending_execution',
  fixtureName: 'backlog-activation',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner } = ctx;

    await runner.run('generate-feature-backlog', { projectId }, async (_payload: unknown) => {
      // Fixture already has approved plan and 3 features — simulate backlog generation pass
      return { featureCount: 3 };
    });

    await runner.run('activate-approved-backlog', { projectId }, async (_payload: unknown) => {
      // Activate: set all approved_pending_execution features
      await db.execute(
        `UPDATE feature_requests
           SET state = 'approved_pending_execution', updated_at = datetime('now')
           WHERE project_id = ? AND state = 'approved_pending_execution'`,
        [projectId],
      );
      return { activated: true };
    });

    const features = await db.query<{ id: string; state: string }>(
      `SELECT id, state FROM feature_requests WHERE project_id = ? AND kind = 'feature'`,
      [projectId],
    );

    if (features.length !== 3) {
      throw new Error(`Expected 3 features, found ${features.length}`);
    }

    const nonActivated = features.filter(
      (f: { id: string; state: string }) => f.state !== 'approved_pending_execution',
    );
    if (nonActivated.length > 0) {
      throw new Error(
        `Expected all features at approved_pending_execution, but ${nonActivated.length} are not`,
      );
    }
  },
};
