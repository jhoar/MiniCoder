import { AdapterRegistry } from '@minicoder/core';
import { runRunCoder } from '@minicoder/triggerdev';
import { MockGitHubClient } from '../services/mock-github-client.js';
import { MockCoderAdapter, MockCoderError } from '../adapters/mock-coder.js';
import type { Scenario, ScenarioContext } from './types.js';

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
}

interface AgentRunRow {
  state: string;
  tokens_used: number | null;
  cost_usd: number | null;
}

async function getFeatureRunByFrId(ctx: ScenarioContext, frSuffix: string): Promise<FeatureRunRow> {
  const rows = await ctx.db.query<FeatureRunRow>(
    `SELECT fr.id, fr.current_execution_state
     FROM feature_runs fr
     JOIN feature_requests freq ON fr.feature_request_id = freq.id
     WHERE freq.project_id = ? AND freq.fr_id = ?`,
    [ctx.projectId, frSuffix],
  );
  const row = rows[0];
  if (!row) throw new Error(`No feature run found for ${frSuffix}`);
  return row;
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/**
 * Registers `MockCoderAdapter` under role `CoderAgentAdapter` in the DB-backed
 * `AdapterRegistry` — mirroring how `packages/testing/src/runner.ts` registers
 * `MockPlannerAdapter` before every scenario, but scoped to this scenario only since it's the
 * first to need a `CoderAgentAdapter` registry entry (Phase 9).
 */
async function registerMockCoderAdapter(ctx: ScenarioContext): Promise<void> {
  const registry = new AdapterRegistry(ctx.db);
  await registry.register({
    role: 'CoderAgentAdapter',
    name: 'MockCoderAdapter',
    implementation: '@minicoder/testing:MockCoderAdapter',
    capabilities: ['can_modify_files', 'can_commit', 'can_push_branch'],
  });
}

export const coderAdapterRunScenario: Scenario = {
  name: 'coder-adapter-run',
  description:
    'run-coder invokes the registered CoderAgentAdapter through AgentRunRecorder (context pack, ' +
    'cost/tool-operation provenance), dispatches RecordCodePushedCommand, and opens a pull ' +
    'request via ScmClient; an adapter failure leaves the feature run at coding with an ' +
    'agent_errors row instead of a false code_pushed transition',
  fixtureName: 'coder-adapter-run',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId } = ctx;
    const correlationId = `corr-coder-adapter-run-${projectId}`;
    await registerMockCoderAdapter(ctx);
    const client = new MockGitHubClient(ctx.github);

    // 1. Happy path: FR-001's feature run is already at `coding` (fixture).
    const fr1 = await getFeatureRunByFrId(ctx, 'FR-001');
    const successAdapter = new MockCoderAdapter('success');

    const result = await ctx.runner.run(
      'run-coder',
      {
        projectId,
        correlationId,
        idempotencyKey: `idem-run-coder-1-${projectId}`,
        featureRunId: fr1.id,
        coderAdapterName: 'MockCoderAdapter',
      },
      runRunCoder,
      undefined,
      { coderAdapterFactory: async () => successAdapter, resolveScmClient: async () => client },
    );

    assertEqual('run-coder pushed', result.result.pushed, true);
    if (result.result.prNumber === null) {
      throw new Error('Expected run-coder to open a pull request');
    }

    const fr1After = await db.query<FeatureRunRow>(
      `SELECT id, current_execution_state FROM feature_runs WHERE id = ?`,
      [fr1.id],
    );
    assertEqual('FR-001 reaches code_pushed', fr1After[0]?.current_execution_state, 'code_pushed');

    const agentRuns = await db.query<AgentRunRow>(
      `SELECT state, tokens_used, cost_usd FROM agent_runs WHERE feature_run_id = ?`,
      [fr1.id],
    );
    if (agentRuns.length !== 1) {
      throw new Error(`Expected exactly 1 agent_runs row for FR-001, got ${agentRuns.length}`);
    }
    assertEqual('agent_runs state', agentRuns[0]?.state, 'succeeded');

    const contextPacks = await db.query<{ id: string }>(
      `SELECT acp.id FROM agent_context_packs acp
       JOIN agent_runs ar ON ar.id = acp.agent_run_id
       WHERE ar.feature_run_id = ?`,
      [fr1.id],
    );
    if (contextPacks.length !== 1) {
      throw new Error(
        `Expected exactly 1 agent_context_packs row for FR-001, got ${contextPacks.length}`,
      );
    }

    if (client.pullRequests.length !== 1) {
      throw new Error(
        `Expected MockGitHubClient to have recorded exactly 1 createPullRequest call, got ${client.pullRequests.length}`,
      );
    }

    // 2. Failure path: FR-002's feature run is also at `coding` (fixture); a failing adapter must
    // not transition it to code_pushed, and the failure must be recorded on agent_runs/agent_errors.
    const fr2 = await getFeatureRunByFrId(ctx, 'FR-002');
    const failingAdapter = new MockCoderAdapter('fail');

    let threw = false;
    try {
      await ctx.runner.run(
        'run-coder',
        {
          projectId,
          correlationId,
          idempotencyKey: `idem-run-coder-2-${projectId}`,
          featureRunId: fr2.id,
          coderAdapterName: 'MockCoderAdapter',
        },
        runRunCoder,
        undefined,
        {
          coderAdapterFactory: async () => failingAdapter,
          resolveScmClient: async () => client,
        },
      );
    } catch (err) {
      threw = true;
      if (!(err instanceof MockCoderError)) {
        throw new Error(`Expected a MockCoderError, got ${String(err)}`);
      }
    }
    if (!threw) {
      throw new Error('Expected run-coder to propagate the failing adapter error');
    }

    const fr2After = await db.query<FeatureRunRow>(
      `SELECT id, current_execution_state FROM feature_runs WHERE id = ?`,
      [fr2.id],
    );
    assertEqual(
      'FR-002 stays at coding after adapter failure',
      fr2After[0]?.current_execution_state,
      'coding',
    );

    const fr2AgentErrors = await db.query<{ error_type: string }>(
      `SELECT ae.error_type FROM agent_errors ae
       JOIN agent_runs ar ON ar.id = ae.agent_run_id
       WHERE ar.feature_run_id = ?`,
      [fr2.id],
    );
    if (fr2AgentErrors.length !== 1) {
      throw new Error(
        `Expected exactly 1 agent_errors row for FR-002, got ${fr2AgentErrors.length}`,
      );
    }
  },
};
