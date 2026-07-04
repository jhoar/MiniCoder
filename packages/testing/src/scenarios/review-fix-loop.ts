import { AdapterRegistry, reconcileGithubState } from '@minicoder/core';
import { runRunReview, runRunCoder } from '@minicoder/triggerdev';
import { MockGitHubClient } from '../services/mock-github-client.js';
import { MockCoderAdapter } from '../adapters/mock-coder.js';
import { MockReviewerAdapter } from '../adapters/mock-reviewer.js';
import type { Scenario, ScenarioContext } from './types.js';

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  fix_attempt_count: number;
}

async function getFeatureRunByFrId(ctx: ScenarioContext, frSuffix: string): Promise<FeatureRunRow> {
  const rows = await ctx.db.query<FeatureRunRow>(
    `SELECT fr.id, fr.current_execution_state, fr.fix_attempt_count
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

async function registerMockCoderAdapter(ctx: ScenarioContext): Promise<void> {
  const registry = new AdapterRegistry(ctx.db);
  await registry.register({
    role: 'CoderAgentAdapter',
    name: 'MockCoderAdapter',
    implementation: '@minicoder/testing:MockCoderAdapter',
    capabilities: ['can_modify_files', 'can_commit', 'can_push_branch'],
  });
}

export const reviewFixLoopScenario: Scenario = {
  name: 'review-fix-loop',
  description:
    'run-review invokes the registered ReviewerAgentAdapter, writes structured review_findings, ' +
    'and drives under_review -> changes_requested -> fixing; run-coder (fixing) writes optimistic ' +
    'coder_responses and resolves findings; the fix-attempt threshold escalates to human_required; ' +
    'a CI failure auto-records a blocking finding via reconcileGithubState',
  fixtureName: 'review-fix-loop',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId } = ctx;
    const correlationId = `corr-review-fix-loop-${projectId}`;
    await registerMockReviewerAdapter(ctx);
    await registerMockCoderAdapter(ctx);
    const client = new MockGitHubClient(ctx.github);

    // ── Case 1: main loop (FR-101) ──────────────────────────────────────────
    const fr1 = await getFeatureRunByFrId(ctx, 'FR-101');
    const reviewer = new MockReviewerAdapter('request_changes');
    const coder = new MockCoderAdapter('success');

    await ctx.runner.run(
      'run-review',
      {
        projectId,
        correlationId,
        idempotencyKey: `idem-review-1-${projectId}`,
        featureRunId: fr1.id,
        reviewerAdapterName: 'MockReviewerAdapter',
      },
      runRunReview,
      undefined,
      { reviewerAdapterFactory: async () => reviewer, githubClientFactory: async () => client },
    );

    const fr1AfterReview = await db.query<FeatureRunRow>(
      `SELECT id, current_execution_state, fix_attempt_count FROM feature_runs WHERE id = ?`,
      [fr1.id],
    );
    assertEqual('FR-101 reaches fixing', fr1AfterReview[0]?.current_execution_state, 'fixing');
    assertEqual('FR-101 fix_attempt_count incremented', fr1AfterReview[0]?.fix_attempt_count, 1);

    const fr1Findings = await db.query<{ id: string; severity: string; resolved: number }>(
      `SELECT id, severity, resolved FROM review_findings WHERE feature_run_id = ?`,
      [fr1.id],
    );
    if (fr1Findings.length !== 2) {
      throw new Error(`Expected 2 review_findings rows for FR-101, got ${fr1Findings.length}`);
    }
    const fr1Blocking = fr1Findings.filter((f) => f.severity === 'blocking');
    if (fr1Blocking.length !== 1) {
      throw new Error(`Expected exactly 1 blocking finding for FR-101, got ${fr1Blocking.length}`);
    }

    await ctx.runner.run(
      'run-coder',
      {
        projectId,
        correlationId,
        idempotencyKey: `idem-coder-1-${projectId}`,
        featureRunId: fr1.id,
        coderAdapterName: 'MockCoderAdapter',
      },
      runRunCoder,
      undefined,
      { coderAdapterFactory: async () => coder, githubClientFactory: async () => client },
    );

    const fr1AfterCoder = await db.query<FeatureRunRow>(
      `SELECT id, current_execution_state, fix_attempt_count FROM feature_runs WHERE id = ?`,
      [fr1.id],
    );
    assertEqual(
      'FR-101 reaches code_pushed after fix',
      fr1AfterCoder[0]?.current_execution_state,
      'code_pushed',
    );

    const fr1ResolvedBlocking = await db.query<{ resolved: number }>(
      `SELECT resolved FROM review_findings WHERE feature_run_id = ? AND severity = 'blocking'`,
      [fr1.id],
    );
    assertEqual('FR-101 blocking finding resolved', fr1ResolvedBlocking[0]?.resolved, 1);

    const fr1CoderResponses = await db.query<{ response_type: string }>(
      `SELECT cr.response_type FROM coder_responses cr
       JOIN review_findings rf ON rf.id = cr.finding_id
       WHERE rf.feature_run_id = ?`,
      [fr1.id],
    );
    // "Optimistic fixed" (Phase 10 design decision #5): one coder_responses row per
    // currently-unresolved review_findings row at the time run-coder ran — both the blocking
    // AND non-blocking findings request_changes produced were unresolved, so both get a response.
    if (fr1CoderResponses.length !== 2) {
      throw new Error(
        `Expected exactly 2 coder_responses rows for FR-101, got ${fr1CoderResponses.length}`,
      );
    }
    for (const response of fr1CoderResponses) {
      assertEqual('FR-101 coder_responses response_type', response.response_type, 'fixed');
    }
    const fr1AllResolved = await db.query<{ resolved: number }>(
      `SELECT resolved FROM review_findings WHERE feature_run_id = ?`,
      [fr1.id],
    );
    for (const finding of fr1AllResolved) {
      assertEqual('FR-101 finding resolved', finding.resolved, 1);
    }

    // Simulate CI passing again on the re-push (mechanics not under test here, mirroring the
    // older review-loop scenario's own raw-SQL state advance for the same reason).
    await db.execute(
      `UPDATE feature_runs SET current_execution_state = 'under_review', updated_at = datetime('now') WHERE id = ?`,
      [fr1.id],
    );

    reviewer.behavior = 'approve';
    const approveResult = await ctx.runner.run(
      'run-review',
      {
        projectId,
        correlationId,
        idempotencyKey: `idem-review-2-${projectId}`,
        featureRunId: fr1.id,
        reviewerAdapterName: 'MockReviewerAdapter',
      },
      runRunReview,
      undefined,
      { reviewerAdapterFactory: async () => reviewer, githubClientFactory: async () => client },
    );
    assertEqual('run-review approve decision', approveResult.result.decision, 'approved');

    const fr1Final = await db.query<FeatureRunRow>(
      `SELECT id, current_execution_state, fix_attempt_count FROM feature_runs WHERE id = ?`,
      [fr1.id],
    );
    assertEqual(
      'FR-101 stays at under_review on approval (no merge gate yet)',
      fr1Final[0]?.current_execution_state,
      'under_review',
    );

    // ── Case 2: fix-attempt threshold exceeded (FR-102) ─────────────────────
    const fr2 = await getFeatureRunByFrId(ctx, 'FR-102');
    assertEqual('FR-102 seeded fix_attempt_count', fr2.fix_attempt_count, 5);
    const reviewer2 = new MockReviewerAdapter('request_changes');

    await ctx.runner.run(
      'run-review',
      {
        projectId,
        correlationId,
        idempotencyKey: `idem-review-threshold-${projectId}`,
        featureRunId: fr2.id,
        reviewerAdapterName: 'MockReviewerAdapter',
      },
      runRunReview,
      undefined,
      { reviewerAdapterFactory: async () => reviewer2, githubClientFactory: async () => client },
    );

    const fr2After = await db.query<FeatureRunRow>(
      `SELECT id, current_execution_state, fix_attempt_count FROM feature_runs WHERE id = ?`,
      [fr2.id],
    );
    assertEqual(
      'FR-102 escalates to human_required once threshold reached',
      fr2After[0]?.current_execution_state,
      'human_required',
    );

    // ── Case 3: CI-failure auto-blocking-finding path (FR-103) ──────────────
    const fr3 = await getFeatureRunByFrId(ctx, 'FR-103');
    ctx.github.simulatePrOpened(103, fr3.id, 'sha-103-initial');
    ctx.github.simulateCheckFailed(103, 'check-ci-103');
    const observed = await client.getPullRequest('minicoder-test', 'review-fix-loop-repo', 103);
    if (!observed) throw new Error('Expected MockGitHubClient.getPullRequest to return a PR state');

    await reconcileGithubState({
      db,
      featureRunId: fr3.id,
      projectId,
      observed,
      correlationId,
    });

    const fr3After = await db.query<FeatureRunRow>(
      `SELECT id, current_execution_state, fix_attempt_count FROM feature_runs WHERE id = ?`,
      [fr3.id],
    );
    assertEqual(
      'FR-103 reaches changes_requested after ci_failed (below threshold)',
      fr3After[0]?.current_execution_state,
      'changes_requested',
    );
    assertEqual('FR-103 fix_attempt_count incremented', fr3After[0]?.fix_attempt_count, 1);

    const fr3Findings = await db.query<{ severity: string; category: string }>(
      `SELECT severity, category FROM review_findings WHERE feature_run_id = ?`,
      [fr3.id],
    );
    if (fr3Findings.length !== 1) {
      throw new Error(
        `Expected exactly 1 review_findings row for FR-103, got ${fr3Findings.length}`,
      );
    }
    assertEqual('FR-103 finding severity', fr3Findings[0]?.severity, 'blocking');
    assertEqual('FR-103 finding category', fr3Findings[0]?.category, 'ci_failure');
  },
};
