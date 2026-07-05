import {
  TransactionalCommandExecutor,
  MergeIfReadyHandler,
  RecordMergedHandler,
  RecordMergeFailedHandler,
  ReconcileMergeFailedHandler,
  EscalateToHumanHandler,
  GithubMergeRejectedError,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope } from '@minicoder/core';
import { runRunMergeGate } from '@minicoder/triggerdev';
import { MockGitHubClient } from '../services/mock-github-client.js';
import type { Scenario, ScenarioContext } from './types.js';
import {
  MERGE_GATE_HAPPY_PR_NUMBER,
  MERGE_GATE_SHA_MISMATCH_PR_NUMBER,
  MERGE_GATE_NOT_MERGEABLE_PR_NUMBER,
} from '../fixtures/merge-gate.js';

interface FeatureRunRow {
  id: string;
  current_execution_state: string;
  version: number;
}

async function getFeatureRunByFrId(ctx: ScenarioContext, frSuffix: string): Promise<FeatureRunRow> {
  const rows = await ctx.db.query<FeatureRunRow>(
    `SELECT fr.id, fr.current_execution_state, fr.version
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
 * Exercises every Merge Gate outcome (docs/06 Phase 12) against the real handlers — no
 * hand-rolled SQL standing in for the state machine (the placeholder this scenario replaced did
 * exactly that, including a `feature_requests.state = 'merged'` write that violated the
 * documented "state is a static label" invariant — see CLAUDE.md's Bootstrap Planner design
 * note).
 */
export const mergeGateScenario: Scenario = {
  name: 'merge-gate',
  description:
    'run-merge-gate approves a clean under_review run and rejects one with an unresolved ' +
    'blocking finding; merge-if-ready re-gates and merges via GitHub; a simulated sha_mismatch ' +
    'merge rejection auto-clears back to under_review, a simulated not_mergeable rejection ' +
    'escalates to human_required',
  fixtureName: 'merge-gate',

  async run(ctx: ScenarioContext): Promise<void> {
    const { db, projectId } = ctx;
    const correlationId = `corr-merge-gate-${projectId}`;
    const client = new MockGitHubClient(ctx.github);
    const executor = new TransactionalCommandExecutor(db);
    const approver = {
      id: 'approver-1',
      role: 'approver' as const,
      actorKind: 'human' as const,
      correlationId,
    };
    const system = {
      id: 'system',
      role: 'admin' as const,
      actorKind: 'system' as const,
      correlationId,
    };

    // ── Case 1: happy path (FR-201) — clean gate, all the way to merged ──────
    const fr201 = await getFeatureRunByFrId(ctx, 'FR-201');
    ctx.github.simulatePrOpened(MERGE_GATE_HAPPY_PR_NUMBER, fr201.id, '201-headsha');

    await ctx.runner.run(
      'run-merge-gate',
      {
        projectId,
        correlationId,
        idempotencyKey: `idem-mg-201-${projectId}`,
        featureRunId: fr201.id,
      },
      runRunMergeGate,
      undefined,
      { githubClientFactory: async () => client },
    );
    const fr201AfterGate = await getFeatureRunByFrId(ctx, 'FR-201');
    assertEqual(
      'FR-201 reaches approved_by_policy',
      fr201AfterGate.current_execution_state,
      'approved_by_policy',
    );

    const fr201Evaluations = await db.query<{ final_decision: string }>(
      `SELECT final_decision FROM merge_gate_evaluations WHERE feature_run_id = ?`,
      [fr201.id],
    );
    assertEqual(
      'FR-201 wrote an approved evaluation',
      fr201Evaluations.some((e) => e.final_decision === 'approved'),
      true,
    );

    const mergeReadyEnvelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `merge-ready:${fr201.id}:${fr201AfterGate.version}`,
      payload: { featureRunId: fr201.id, projectId, expectedVersion: fr201AfterGate.version },
      actor: approver,
      correlationId,
    };
    await executor.execute(new MergeIfReadyHandler(), mergeReadyEnvelope);
    const fr201AtMergeReady = await getFeatureRunByFrId(ctx, 'FR-201');
    assertEqual(
      'FR-201 reaches merge_ready',
      fr201AtMergeReady.current_execution_state,
      'merge_ready',
    );

    const { mergeSha } = await client.mergePullRequest({
      owner: 'minicoder-test',
      repo: 'merge-gate-repo',
      prNumber: MERGE_GATE_HAPPY_PR_NUMBER,
      mergeMethod: 'squash',
    });
    const recordMergedEnvelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `record-merged:${fr201.id}:${mergeSha}`,
      payload: {
        featureRunId: fr201.id,
        projectId,
        expectedVersion: fr201AtMergeReady.version,
        mergeSha,
      },
      actor: system,
      correlationId,
    };
    await executor.execute(new RecordMergedHandler(), recordMergedEnvelope);
    const fr201Final = await getFeatureRunByFrId(ctx, 'FR-201');
    assertEqual('FR-201 reaches merged', fr201Final.current_execution_state, 'merged');

    const wsRows = await db.query<{ active_feature_run_id: string | null }>(
      `SELECT active_feature_run_id FROM workflow_states WHERE project_id = ?`,
      [projectId],
    );
    assertEqual(
      'active_feature_run_id cleared after merge',
      wsRows[0]?.active_feature_run_id,
      null,
    );

    // ── Case 2: rejected gate (FR-202) — unresolved blocking finding ─────────
    const fr202 = await getFeatureRunByFrId(ctx, 'FR-202');
    const mgResult202 = await ctx.runner.run(
      'run-merge-gate',
      {
        projectId,
        correlationId,
        idempotencyKey: `idem-mg-202-${projectId}`,
        featureRunId: fr202.id,
      },
      runRunMergeGate,
      undefined,
      { githubClientFactory: async () => client },
    );
    assertEqual('FR-202 gate reports not approved', mgResult202.result.approved, false);
    const fr202AfterGate = await getFeatureRunByFrId(ctx, 'FR-202');
    assertEqual(
      'FR-202 stays at under_review',
      fr202AfterGate.current_execution_state,
      'under_review',
    );
    const fr202Evaluations = await db.query<{ final_decision: string }>(
      `SELECT final_decision FROM merge_gate_evaluations WHERE feature_run_id = ?`,
      [fr202.id],
    );
    assertEqual(
      'FR-202 wrote a rejected evaluation',
      fr202Evaluations.some((e) => e.final_decision === 'rejected'),
      true,
    );

    // ── Case 3: merge failure, sha_mismatch (auto-clearable) (FR-203) ────────
    const fr203 = await getFeatureRunByFrId(ctx, 'FR-203');
    ctx.github.simulatePrOpened(MERGE_GATE_SHA_MISMATCH_PR_NUMBER, fr203.id, '203-headsha');
    ctx.github.simulateMergeConflict(MERGE_GATE_SHA_MISMATCH_PR_NUMBER, 'sha_mismatch');

    const mergeReady203Envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `merge-ready:${fr203.id}:${fr203.version}`,
      payload: { featureRunId: fr203.id, projectId, expectedVersion: fr203.version },
      actor: approver,
      correlationId,
    };
    await executor.execute(new MergeIfReadyHandler(), mergeReady203Envelope);
    const fr203AtMergeReady = await getFeatureRunByFrId(ctx, 'FR-203');
    assertEqual(
      'FR-203 reaches merge_ready',
      fr203AtMergeReady.current_execution_state,
      'merge_ready',
    );

    let fr203CaughtRejection: GithubMergeRejectedError | undefined;
    try {
      await client.mergePullRequest({
        owner: 'minicoder-test',
        repo: 'merge-gate-repo',
        prNumber: MERGE_GATE_SHA_MISMATCH_PR_NUMBER,
        mergeMethod: 'squash',
      });
    } catch (err) {
      if (err instanceof GithubMergeRejectedError) fr203CaughtRejection = err;
      else throw err;
    }
    if (!fr203CaughtRejection) throw new Error('Expected FR-203 merge to be rejected');
    assertEqual('FR-203 rejection is auto-clearable', fr203CaughtRejection.autoClearable, true);

    const failed203Envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `record-merge-failed:${fr203.id}:${fr203AtMergeReady.version}`,
      payload: {
        featureRunId: fr203.id,
        projectId,
        expectedVersion: fr203AtMergeReady.version,
        reason: fr203CaughtRejection.message,
        autoClearable: true,
      },
      actor: system,
      correlationId,
    };
    await executor.execute(new RecordMergeFailedHandler(), failed203Envelope);
    const fr203AtFailed = await getFeatureRunByFrId(ctx, 'FR-203');
    assertEqual(
      'FR-203 reaches merge_failed',
      fr203AtFailed.current_execution_state,
      'merge_failed',
    );

    const reconcile203Envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `reconcile-merge-failed:${fr203.id}:${fr203AtFailed.version}`,
      payload: { featureRunId: fr203.id, projectId, expectedVersion: fr203AtFailed.version },
      actor: system,
      correlationId,
    };
    await executor.execute(new ReconcileMergeFailedHandler(), reconcile203Envelope);
    const fr203Final = await getFeatureRunByFrId(ctx, 'FR-203');
    assertEqual(
      'FR-203 auto-clears back to under_review',
      fr203Final.current_execution_state,
      'under_review',
    );

    // ── Case 4: merge failure, not_mergeable (escalates to human) (FR-204) ───
    const fr204 = await getFeatureRunByFrId(ctx, 'FR-204');
    ctx.github.simulatePrOpened(MERGE_GATE_NOT_MERGEABLE_PR_NUMBER, fr204.id, '204-headsha');
    ctx.github.simulateMergeConflict(MERGE_GATE_NOT_MERGEABLE_PR_NUMBER, 'not_mergeable');

    const mergeReady204Envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `merge-ready:${fr204.id}:${fr204.version}`,
      payload: { featureRunId: fr204.id, projectId, expectedVersion: fr204.version },
      actor: approver,
      correlationId,
    };
    await executor.execute(new MergeIfReadyHandler(), mergeReady204Envelope);
    const fr204AtMergeReady = await getFeatureRunByFrId(ctx, 'FR-204');

    let fr204CaughtRejection: GithubMergeRejectedError | undefined;
    try {
      await client.mergePullRequest({
        owner: 'minicoder-test',
        repo: 'merge-gate-repo',
        prNumber: MERGE_GATE_NOT_MERGEABLE_PR_NUMBER,
        mergeMethod: 'squash',
      });
    } catch (err) {
      if (err instanceof GithubMergeRejectedError) fr204CaughtRejection = err;
      else throw err;
    }
    if (!fr204CaughtRejection) throw new Error('Expected FR-204 merge to be rejected');
    assertEqual(
      'FR-204 rejection is not auto-clearable',
      fr204CaughtRejection.autoClearable,
      false,
    );

    const failed204Envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `record-merge-failed:${fr204.id}:${fr204AtMergeReady.version}`,
      payload: {
        featureRunId: fr204.id,
        projectId,
        expectedVersion: fr204AtMergeReady.version,
        reason: fr204CaughtRejection.message,
        autoClearable: false,
      },
      actor: system,
      correlationId,
    };
    await executor.execute(new RecordMergeFailedHandler(), failed204Envelope);
    const fr204AtFailed = await getFeatureRunByFrId(ctx, 'FR-204');

    const escalate204Envelope: CommandEnvelope<Record<string, unknown>> = {
      commandId: generateId(),
      idempotencyKey: `escalate-human-merge-failed:${fr204.id}`,
      payload: {
        featureRunId: fr204.id,
        projectId,
        expectedVersion: fr204AtFailed.version,
        reason: fr204CaughtRejection.message,
      },
      actor: system,
      correlationId,
    };
    await executor.execute(new EscalateToHumanHandler(), escalate204Envelope);
    const fr204Final = await getFeatureRunByFrId(ctx, 'FR-204');
    assertEqual(
      'FR-204 escalates to human_required',
      fr204Final.current_execution_state,
      'human_required',
    );
  },
};
