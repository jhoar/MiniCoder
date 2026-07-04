import { describe, it, expect } from 'vitest';
import type { CoderAgentAdapter, CoderInput, CoderOutput, DbClient, GitHubClient } from '@minicoder/core';
import { FeatureExecutionState } from '@minicoder/core';
import { createTestDb, insertTestProject } from '../test-helpers.js';
import { runImpl, type RunCoderDeps } from './run-coder.js';

const PROJECT_ID = 'proj-run-coder-001';

interface FixtureIds {
  featureRunId: string;
}

async function seedCodingFeatureRun(
  db: DbClient,
  opts: { state?: string } = {},
): Promise<FixtureIds> {
  const planId = `plan-${PROJECT_ID}`;
  const frId = `fr-${PROJECT_ID}-1`;
  const featureRunId = `run-${PROJECT_ID}-1`;

  await db.execute(
    `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
     VALUES (?, ?, 'minicoder-test', 'run-coder-repo', 'minicoder-test/run-coder-repo', 'main', 1, datetime('now'), datetime('now'))`,
    [`repo-${PROJECT_ID}`, PROJECT_ID],
  );
  await db.execute(
    `INSERT OR IGNORE INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
    [planId, PROJECT_ID],
  );
  await db.execute(
    `INSERT OR IGNORE INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Add widget', 'Description', 'feature', 1, 'approved_pending_execution', 0, 1, datetime('now'), datetime('now'))`,
    [frId, planId, PROJECT_ID],
  );
  await db.execute(
    `INSERT OR IGNORE INTO acceptance_criteria (id, feature_request_id, description, order_index, version, created_at, updated_at)
     VALUES (?, ?, 'The widget renders', 0, 1, datetime('now'), datetime('now'))`,
    [`ac-${frId}-1`, frId],
  );
  await db.execute(
    `INSERT OR IGNORE INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
     VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
    [featureRunId, frId, opts.state ?? FeatureExecutionState.CODING],
  );
  await db.execute(
    `INSERT OR IGNORE INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 1, datetime('now'), datetime('now'))`,
    [`ws-${PROJECT_ID}`, PROJECT_ID, featureRunId],
  );

  return { featureRunId };
}

async function registerCoderAdapter(db: DbClient, name = 'FakeCoderAdapter'): Promise<void> {
  const now = new Date().toISOString();
  const adapterId = `adapter-${name}`;
  await db.execute(
    `INSERT OR IGNORE INTO agent_adapters (id, role, name, implementation, is_active, version, created_at, updated_at)
     VALUES (?, 'CoderAgentAdapter', ?, 'test:FakeCoderAdapter', 1, 1, ?, ?)`,
    [adapterId, name, now, now],
  );
  for (const capability of ['can_modify_files', 'can_commit', 'can_push_branch']) {
    await db.execute(
      `INSERT OR IGNORE INTO agent_capabilities (id, adapter_id, capability, created_at) VALUES (?, ?, ?, ?)`,
      [`${adapterId}-${capability}`, adapterId, capability, now],
    );
  }
}

function fakeCoderAdapter(behavior: 'success' | 'fail' = 'success'): CoderAgentAdapter {
  return {
    role: 'CoderAgentAdapter',
    async run(input: CoderInput): Promise<CoderOutput & { tokensUsed?: unknown; toolOperations?: unknown }> {
      if (behavior === 'fail') {
        throw new Error('generation failed');
      }
      return {
        commitSha: `sha-${input.featureRunId}`,
        branchName: `minicoder/${input.featureRunId}`,
        filesChanged: 2,
        tokensUsed: { input: 100, output: 40 },
        toolOperations: [{ toolName: 'git-clone', status: 'success', durationMs: 50 }],
      };
    },
  };
}

function fakeGithubClient(opts: { fail?: boolean } = {}): GitHubClient & {
  createdPullRequests: Array<{ owner: string; repo: string; branchName: string }>;
} {
  const createdPullRequests: Array<{ owner: string; repo: string; branchName: string }> = [];
  return {
    createdPullRequests,
    async createBranch() {
      return { branchName: 'minicoder/x', sha: 'abc' };
    },
    async createPullRequest(options) {
      if (opts.fail) throw new Error('github API unavailable');
      createdPullRequests.push({ owner: options.owner, repo: options.repo, branchName: options.branchName });
      return { prNumber: 42, branchName: options.branchName };
    },
    async getPullRequest() {
      return null;
    },
    async publishStatusCheck() {},
    async getRemainingRateLimit() {
      return 5000;
    },
  };
}

describe('run-coder', () => {
  it('no-ops when the feature run is not at coding', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedCodingFeatureRun(db, {
      state: FeatureExecutionState.APPROVED_PENDING_EXECUTION,
    });
    await registerCoderAdapter(db);

    const result = await runImpl(
      { projectId: PROJECT_ID, featureRunId, correlationId: 'corr-1', idempotencyKey: 'idem-1', coderAdapterName: 'FakeCoderAdapter' },
      db,
    );

    expect(result.pushed).toBe(false);
    expect(result.prNumber).toBeNull();
  });

  it('invokes the coder adapter, records provenance, transitions to code_pushed, and opens a PR', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedCodingFeatureRun(db);
    await registerCoderAdapter(db);

    const adapter = fakeCoderAdapter('success');
    const client = fakeGithubClient();
    const deps: RunCoderDeps = {
      coderAdapterFactory: async () => adapter,
      githubClientFactory: async () => client,
    };

    const result = await runImpl(
      { projectId: PROJECT_ID, featureRunId, correlationId: 'corr-2', idempotencyKey: 'idem-2', coderAdapterName: 'FakeCoderAdapter' },
      db,
      deps,
    );

    expect(result.pushed).toBe(true);
    expect(result.prNumber).toBe(42);
    expect(client.createdPullRequests).toHaveLength(1);

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.CODE_PUSHED);

    const agentRuns = await db.query<{
      state: string;
      tokens_used: number | null;
      cost_usd: number | null;
    }>(`SELECT state, tokens_used, cost_usd FROM agent_runs WHERE feature_run_id = ?`, [
      featureRunId,
    ]);
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]?.state).toBe('succeeded');
    expect(agentRuns[0]?.tokens_used).toBe(140);

    const contextPacks = await db.query<{ id: string }>(
      `SELECT acp.id FROM agent_context_packs acp
       JOIN agent_runs ar ON ar.id = acp.agent_run_id
       WHERE ar.feature_run_id = ?`,
      [featureRunId],
    );
    expect(contextPacks).toHaveLength(1);

    const toolOps = await db.query<{ tool_name: string }>(
      `SELECT ato.tool_name FROM agent_tool_operations ato
       JOIN agent_runs ar ON ar.id = ato.agent_run_id
       WHERE ar.feature_run_id = ?`,
      [featureRunId],
    );
    expect(toolOps.map((r) => r.tool_name)).toEqual(['git-clone']);
  });

  it('does not roll back the code_pushed transition when PR creation fails', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedCodingFeatureRun(db);
    await registerCoderAdapter(db);

    const adapter = fakeCoderAdapter('success');
    const client = fakeGithubClient({ fail: true });

    const result = await runImpl(
      { projectId: PROJECT_ID, featureRunId, correlationId: 'corr-3', idempotencyKey: 'idem-3', coderAdapterName: 'FakeCoderAdapter' },
      db,
      { coderAdapterFactory: async () => adapter, githubClientFactory: async () => client },
    );

    expect(result.pushed).toBe(true);
    expect(result.prNumber).toBeNull();

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.CODE_PUSHED);
  });

  it('does not transition to code_pushed when the coder adapter fails', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedCodingFeatureRun(db);
    await registerCoderAdapter(db);

    const adapter = fakeCoderAdapter('fail');
    const client = fakeGithubClient();

    await expect(
      runImpl(
        { projectId: PROJECT_ID, featureRunId, correlationId: 'corr-4', idempotencyKey: 'idem-4', coderAdapterName: 'FakeCoderAdapter' },
        db,
        { coderAdapterFactory: async () => adapter, githubClientFactory: async () => client },
      ),
    ).rejects.toThrow('generation failed');

    const runRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(runRows[0]?.current_execution_state).toBe(FeatureExecutionState.CODING);

    const agentRuns = await db.query<{ state: string }>(
      `SELECT state FROM agent_runs WHERE feature_run_id = ?`,
      [featureRunId],
    );
    expect(agentRuns[0]?.state).toBe('failed');
  });
});
