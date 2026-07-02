import { runGithubReconciliation } from '@minicoder/triggerdev';
import { MockGitHubClient } from '../services/mock-github-client.js';
import { GITHUB_RACE_PR_NUMBER } from '../fixtures/github-race.js';
import type { Scenario, ScenarioContext } from './types.js';

export const githubRaceScenario: Scenario = {
  name: 'github-race',
  description:
    'PR closed without merging while CI still running (a GitHub race condition) → github-reconciliation task escalates the feature run to human_required via the real state machine',
  fixtureName: 'github-race',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId, runner, github } = ctx;

    const featureRun = await db.query<{
      id: string;
      feature_request_id: string;
      current_execution_state: string;
    }>(
      `SELECT fr.id, fr.feature_request_id, fr.current_execution_state
       FROM feature_runs fr
       JOIN feature_requests freq ON fr.feature_request_id = freq.id
       WHERE freq.project_id = ?
       LIMIT 1`,
      [projectId],
    );

    if (!featureRun[0]) {
      throw new Error('No feature run found for github-race scenario');
    }
    const { id: featureRunId, feature_request_id: featureRequestId } = featureRun[0];

    const requestStateBefore = await db.query<{ state: string }>(
      `SELECT state FROM feature_requests WHERE id = ?`,
      [featureRequestId],
    );

    // Seed the mock GitHub provider: PR was open with CI running, then closed without merging —
    // the race the fixture's pull_requests row (state='open', ci_status='running') does not yet
    // reflect.
    github.simulatePrOpened(GITHUB_RACE_PR_NUMBER, featureRunId, 'abc0000000');
    github.simulatePrClosed(GITHUB_RACE_PR_NUMBER);

    const client = new MockGitHubClient(github);

    const runResult = await runner.run(
      'github-reconciliation',
      {
        projectId,
        correlationId: `corr-github-race-${projectId}`,
        idempotencyKey: `idem-github-race-${projectId}`,
        featureRunId,
      },
      runGithubReconciliation,
      undefined,
      async () => client,
    );

    if (runResult.result.humanRequired !== 1) {
      throw new Error(
        `Expected github-reconciliation to escalate exactly 1 feature run to human_required, got ${runResult.result.humanRequired}`,
      );
    }

    const finalState = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );

    const state = finalState[0]?.current_execution_state;
    if (state !== 'human_required') {
      throw new Error(`Expected feature_run state 'human_required', got '${state}'`);
    }

    // feature_requests.state is a static label set once at backlog generation — reconciliation
    // must never touch it (CLAUDE.md "feature_requests.state is a static label").
    const requestStateAfter = await db.query<{ state: string }>(
      `SELECT state FROM feature_requests WHERE id = ?`,
      [featureRequestId],
    );
    if (requestStateAfter[0]?.state !== requestStateBefore[0]?.state) {
      throw new Error(
        `feature_requests.state must remain unchanged; was '${requestStateBefore[0]?.state}', now '${requestStateAfter[0]?.state}'`,
      );
    }
  },
};
