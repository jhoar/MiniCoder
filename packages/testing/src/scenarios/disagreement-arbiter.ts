import { AdapterRegistry } from '@minicoder/core';
import { runRunReview } from '@minicoder/triggerdev';
import { MockGitHubClient } from '../services/mock-github-client.js';
import { MockReviewerAdapter } from '../adapters/mock-reviewer.js';
import { MockArbiterAdapter } from '../adapters/mock-arbiter.js';
import type { Scenario, ScenarioContext } from './types.js';

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
}

async function getFeatureRun(ctx: ScenarioContext, frSuffix: string): Promise<FeatureRunRow> {
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

async function registerMockReviewerAdapter(ctx: ScenarioContext): Promise<void> {
  const registry = new AdapterRegistry(ctx.db);
  await registry.register({
    role: 'ReviewerAgentAdapter',
    name: 'MockReviewerAdapter',
    implementation: '@minicoder/testing:MockReviewerAdapter',
    capabilities: ['can_review_pull_request', 'can_return_structured_findings'],
  });
}

async function registerMockArbiterAdapter(ctx: ScenarioContext): Promise<void> {
  const registry = new AdapterRegistry(ctx.db);
  await registry.register({
    role: 'ArbiterAgentAdapter',
    name: 'MockArbiterAdapter',
    implementation: '@minicoder/testing:MockArbiterAdapter',
    capabilities: ['can_resolve_disagreement'],
  });
}

export const disagreementArbiterScenario: Scenario = {
  name: 'disagreement-arbiter',
  description:
    'run-review detects a blocking finding repeating across review cycles, opens a ' +
    "disagreement_records row, and invokes ArbiterAgentAdapter — resolving in the reviewer's " +
    'favor continues the fix loop; a subsequent repeat that the Arbiter escalates reaches ' +
    'human_required',
  fixtureName: 'disagreement-arbiter',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId } = ctx;
    const correlationId = `corr-disagreement-arbiter-${projectId}`;
    await registerMockReviewerAdapter(ctx);
    await registerMockArbiterAdapter(ctx);
    const client = new MockGitHubClient(ctx.github);

    const fr = await getFeatureRun(ctx, 'FR-201');
    const reviewer = new MockReviewerAdapter('repeat_finding');

    // ── Cycle 1: no prior finding to repeat, proceeds to changes_requested normally ──
    await ctx.runner.run(
      'run-review',
      {
        projectId,
        correlationId,
        idempotencyKey: `idem-review-1-${projectId}`,
        featureRunId: fr.id,
        reviewerAdapterName: 'MockReviewerAdapter',
      },
      runRunReview,
      undefined,
      { reviewerAdapterFactory: async () => reviewer, resolveScmClient: async () => client },
    );

    const afterCycle1 = await db.query<FeatureRunRow>(
      `SELECT id, current_execution_state FROM feature_runs WHERE id = ?`,
      [fr.id],
    );
    assertEqual('cycle 1 reaches fixing', afterCycle1[0]?.current_execution_state, 'fixing');

    const disagreementsAfterCycle1 = await db.query<{ id: string }>(
      `SELECT id FROM disagreement_records WHERE feature_run_id = ?`,
      [fr.id],
    );
    if (disagreementsAfterCycle1.length !== 0) {
      throw new Error('Expected no disagreement_records after the first cycle (nothing to repeat)');
    }

    // Simulate the re-push landing back at under_review (mechanics not under test here, mirroring
    // review-fix-loop.ts's own raw-SQL state advance for the same reason).
    await db.execute(
      `UPDATE feature_runs SET current_execution_state = 'under_review', updated_at = datetime('now') WHERE id = ?`,
      [fr.id],
    );

    // ── Cycle 2: the identical finding repeats — Arbiter resolves in the reviewer's favor ──
    const arbiter = new MockArbiterAdapter('resolve');
    const result2 = await ctx.runner.run(
      'run-review',
      {
        projectId,
        correlationId,
        idempotencyKey: `idem-review-2-${projectId}`,
        featureRunId: fr.id,
        reviewerAdapterName: 'MockReviewerAdapter',
        arbiterAdapterName: 'MockArbiterAdapter',
      },
      runRunReview,
      undefined,
      {
        reviewerAdapterFactory: async () => reviewer,
        resolveScmClient: async () => client,
        arbiterAdapterFactory: async () => arbiter,
      },
    );
    assertEqual('cycle 2 decision', result2.result.decision, 'changes_requested');

    const afterCycle2 = await db.query<FeatureRunRow>(
      `SELECT id, current_execution_state FROM feature_runs WHERE id = ?`,
      [fr.id],
    );
    assertEqual(
      'cycle 2 reaches fixing (Arbiter sided with reviewer)',
      afterCycle2[0]?.current_execution_state,
      'fixing',
    );

    const disagreementsAfterCycle2 = await db.query<{
      id: string;
      state: string;
      resolution: string | null;
    }>(`SELECT id, state, resolution FROM disagreement_records WHERE feature_run_id = ?`, [fr.id]);
    if (disagreementsAfterCycle2.length !== 1) {
      throw new Error(
        `Expected exactly 1 disagreement_records row after cycle 2, got ${disagreementsAfterCycle2.length}`,
      );
    }
    assertEqual('disagreement resolved by Arbiter', disagreementsAfterCycle2[0]?.state, 'resolved');

    // ── Cycle 3: repeats again — Arbiter now escalates to a human ──
    await db.execute(
      `UPDATE feature_runs SET current_execution_state = 'under_review', updated_at = datetime('now') WHERE id = ?`,
      [fr.id],
    );
    const escalatingArbiter = new MockArbiterAdapter('escalate');
    const result3 = await ctx.runner.run(
      'run-review',
      {
        projectId,
        correlationId,
        idempotencyKey: `idem-review-3-${projectId}`,
        featureRunId: fr.id,
        reviewerAdapterName: 'MockReviewerAdapter',
        arbiterAdapterName: 'MockArbiterAdapter',
      },
      runRunReview,
      undefined,
      {
        reviewerAdapterFactory: async () => reviewer,
        resolveScmClient: async () => client,
        arbiterAdapterFactory: async () => escalatingArbiter,
      },
    );
    assertEqual('cycle 3 decision', result3.result.decision, 'escalated');

    const afterCycle3 = await db.query<FeatureRunRow>(
      `SELECT id, current_execution_state FROM feature_runs WHERE id = ?`,
      [fr.id],
    );
    assertEqual(
      'cycle 3 escalates to human_required',
      afterCycle3[0]?.current_execution_state,
      'human_required',
    );

    const disagreementsAfterCycle3 = await db.query<{ state: string }>(
      `SELECT state FROM disagreement_records WHERE feature_run_id = ? ORDER BY review_cycle DESC LIMIT 1`,
      [fr.id],
    );
    assertEqual('latest disagreement escalated', disagreementsAfterCycle3[0]?.state, 'escalated');
  },
};
