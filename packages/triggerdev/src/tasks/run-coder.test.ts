import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  CoderAgentAdapter,
  CoderInput,
  CoderOutput,
  DbClient,
  GitHubClient,
} from '@minicoder/core';
import { EVENT_SCHEMAS, FeatureExecutionState } from '@minicoder/core';
import { createTestDb, insertTestProject } from '../test-helpers.js';
import { runImpl, type RunCoderDeps } from './run-coder.js';

const PROJECT_ID = 'proj-run-coder-001';

interface FixtureIds {
  featureRunId: string;
}

async function seedCodingFeatureRun(
  db: DbClient,
  opts: { state?: string; defaultBranch?: string } = {},
): Promise<FixtureIds> {
  const planId = `plan-${PROJECT_ID}`;
  const frId = `fr-${PROJECT_ID}-1`;
  const featureRunId = `run-${PROJECT_ID}-1`;

  await db.execute(
    `INSERT OR IGNORE INTO repositories (id, project_id, owner, name, full_name, default_branch, version, created_at, updated_at)
     VALUES (?, ?, 'minicoder-test', 'run-coder-repo', 'minicoder-test/run-coder-repo', ?, 1, datetime('now'), datetime('now'))`,
    [`repo-${PROJECT_ID}`, PROJECT_ID, opts.defaultBranch ?? 'main'],
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
    async run(
      input: CoderInput,
    ): Promise<CoderOutput & { tokensUsed?: unknown; toolOperations?: unknown }> {
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
  createdPullRequests: Array<{
    owner: string;
    repo: string;
    branchName: string;
    baseBranch: string;
  }>;
} {
  const createdPullRequests: Array<{
    owner: string;
    repo: string;
    branchName: string;
    baseBranch: string;
  }> = [];
  return {
    createdPullRequests,
    async createBranch() {
      return { branchName: 'minicoder/x', sha: 'abc' };
    },
    async createPullRequest(options) {
      if (opts.fail) throw new Error('github API unavailable');
      createdPullRequests.push({
        owner: options.owner,
        repo: options.repo,
        branchName: options.branchName,
        baseBranch: options.baseBranch,
      });
      return { prNumber: 42, branchName: options.branchName };
    },
    async mergePullRequest() {
      throw new Error('not used in this test');
    },
    async getPullRequest() {
      return null;
    },
    async publishStatusCheck() {},
    async getRemainingRateLimit() {
      return 5000;
    },
    async getPullRequestDiff() {
      return 'diff --git a/x b/x\n';
    },
    async listPullRequestsForBranch() {
      return [];
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
      {
        projectId: PROJECT_ID,
        featureRunId,
        correlationId: 'corr-1',
        idempotencyKey: 'idem-1',
        coderAdapterName: 'FakeCoderAdapter',
      },
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
      {
        projectId: PROJECT_ID,
        featureRunId,
        correlationId: 'corr-2',
        idempotencyKey: 'idem-2',
        coderAdapterName: 'FakeCoderAdapter',
      },
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
      prompt_template_version: string | null;
    }>(
      `SELECT state, tokens_used, cost_usd, prompt_template_version FROM agent_runs WHERE feature_run_id = ?`,
      [featureRunId],
    );
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]?.state).toBe('succeeded');
    expect(agentRuns[0]?.tokens_used).toBe(140);
    expect(agentRuns[0]?.cost_usd).toBeGreaterThan(0);
    // MEDIUM-1 code-review fix (round 2) regression: a real coder run must populate
    // prompt_template_version, not just synthetic recorder-level test calls.
    expect(agentRuns[0]?.prompt_template_version).toBeTruthy();

    // HIGH-5 code-review fix regression: a coder run must write a cost_records row so budget
    // gates summing cost_records actually see coder spend.
    const costRecords = await db.query<{ amount: number; scope: string }>(
      `SELECT cr.amount, cr.scope FROM cost_records cr
       JOIN agent_runs ar ON ar.id = cr.agent_run_id
       WHERE ar.feature_run_id = ?`,
      [featureRunId],
    );
    expect(costRecords).toHaveLength(1);
    expect(costRecords[0]?.amount).toBeGreaterThan(0);
    expect(costRecords[0]?.scope).toBe('feature');

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

    // CRITICAL-1 code-review fix regression: the emitted feature.code_pushed outbox payload must
    // actually validate against its registered EVENT_SCHEMAS entry — featureRunId/projectId here
    // are generateId() strings (`${Date.now()}-${random}`), never UUIDs, so a `.uuid()` schema
    // would reject every real payload this handler emits.
    const outboxRows = await db.query<{ payload: string }>(
      `SELECT payload FROM outbox_events WHERE event_type = 'feature.code_pushed' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(outboxRows).toHaveLength(1);
    const payload: unknown = JSON.parse(outboxRows[0]?.payload ?? '{}');
    expect(() => EVENT_SCHEMAS['feature.code_pushed']?.parse(payload)).not.toThrow();
  });

  it('does not roll back the code_pushed transition when PR creation fails', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedCodingFeatureRun(db);
    await registerCoderAdapter(db);

    const adapter = fakeCoderAdapter('success');
    const client = fakeGithubClient({ fail: true });

    const result = await runImpl(
      {
        projectId: PROJECT_ID,
        featureRunId,
        correlationId: 'corr-3',
        idempotencyKey: 'idem-3',
        coderAdapterName: 'FakeCoderAdapter',
      },
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
        {
          projectId: PROJECT_ID,
          featureRunId,
          correlationId: 'corr-4',
          idempotencyKey: 'idem-4',
          coderAdapterName: 'FakeCoderAdapter',
        },
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

  it('opens the PR against the repository default_branch, not a hardcoded main (HIGH-6 regression)', async () => {
    const db = createTestDb();
    insertTestProject(db, PROJECT_ID);
    const { featureRunId } = await seedCodingFeatureRun(db, { defaultBranch: 'develop' });
    await registerCoderAdapter(db);

    const adapter = fakeCoderAdapter('success');
    const client = fakeGithubClient();

    await runImpl(
      {
        projectId: PROJECT_ID,
        featureRunId,
        correlationId: 'corr-5',
        idempotencyKey: 'idem-5',
        coderAdapterName: 'FakeCoderAdapter',
      },
      db,
      { coderAdapterFactory: async () => adapter, githubClientFactory: async () => client },
    );

    expect(client.createdPullRequests).toHaveLength(1);
    expect(client.createdPullRequests[0]?.baseBranch).toBe('develop');
  });

  describe('cost pricing env var validation (MEDIUM-3 code-review fix, round 2)', () => {
    const PRICE_ENV_VARS = [
      'CODE_GEN_PRICE_PER_1K_INPUT_TOKENS',
      'CODE_GEN_PRICE_PER_1K_OUTPUT_TOKENS',
    ] as const;
    const originalValues = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const name of PRICE_ENV_VARS) originalValues.set(name, process.env[name]);
    });

    afterEach(() => {
      for (const name of PRICE_ENV_VARS) {
        const original = originalValues.get(name);
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
      }
    });

    it.each(['not-a-number', 'NaN', 'Infinity', '-1', '', '   '])(
      'falls back to the default price when the env var is invalid (%s)',
      async (badValue) => {
        process.env['CODE_GEN_PRICE_PER_1K_INPUT_TOKENS'] = badValue;

        const db = createTestDb();
        insertTestProject(db, PROJECT_ID);
        const { featureRunId } = await seedCodingFeatureRun(db);
        await registerCoderAdapter(db);

        await runImpl(
          {
            projectId: PROJECT_ID,
            featureRunId,
            correlationId: 'corr-price',
            idempotencyKey: 'idem-price',
            coderAdapterName: 'FakeCoderAdapter',
          },
          db,
          {
            coderAdapterFactory: async () => fakeCoderAdapter('success'),
            githubClientFactory: async () => fakeGithubClient(),
          },
        );

        const agentRuns = await db.query<{ cost_usd: number | null }>(
          `SELECT cost_usd FROM agent_runs WHERE feature_run_id = ?`,
          [featureRunId],
        );
        const costUsd = agentRuns[0]?.cost_usd;
        expect(costUsd).not.toBeNull();
        expect(Number.isFinite(costUsd)).toBe(true);
        expect(costUsd as number).toBeGreaterThan(0);
      },
    );

    it('honors a valid custom price', async () => {
      process.env['CODE_GEN_PRICE_PER_1K_INPUT_TOKENS'] = '1';
      process.env['CODE_GEN_PRICE_PER_1K_OUTPUT_TOKENS'] = '2';

      const db = createTestDb();
      insertTestProject(db, PROJECT_ID);
      const { featureRunId } = await seedCodingFeatureRun(db);
      await registerCoderAdapter(db);

      await runImpl(
        {
          projectId: PROJECT_ID,
          featureRunId,
          correlationId: 'corr-price-2',
          idempotencyKey: 'idem-price-2',
          coderAdapterName: 'FakeCoderAdapter',
        },
        db,
        {
          coderAdapterFactory: async () => fakeCoderAdapter('success'),
          githubClientFactory: async () => fakeGithubClient(),
        },
      );

      // fakeCoderAdapter reports { input: 100, output: 40 } tokens (140 total, see tokensUsed above).
      const agentRuns = await db.query<{ cost_usd: number }>(
        `SELECT cost_usd FROM agent_runs WHERE feature_run_id = ?`,
        [featureRunId],
      );
      expect(agentRuns[0]?.cost_usd).toBeCloseTo((100 / 1000) * 1 + (40 / 1000) * 2, 6);
    });
  });

  describe('prompt template version env var validation (MEDIUM-1 code-review fix, round 3)', () => {
    const ENV_VAR = 'CODER_PROMPT_TEMPLATE_VERSION';
    let original: string | undefined;

    beforeEach(() => {
      original = process.env[ENV_VAR];
    });

    afterEach(() => {
      if (original === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = original;
    });

    it.each(['', '   '])(
      'falls back to the default prompt template version when the env var is blank (%j)',
      async (blankValue) => {
        process.env[ENV_VAR] = blankValue;

        const db = createTestDb();
        insertTestProject(db, PROJECT_ID);
        const { featureRunId } = await seedCodingFeatureRun(db);
        await registerCoderAdapter(db);

        await runImpl(
          {
            projectId: PROJECT_ID,
            featureRunId,
            correlationId: 'corr-prompt-version',
            idempotencyKey: 'idem-prompt-version',
            coderAdapterName: 'FakeCoderAdapter',
          },
          db,
          {
            coderAdapterFactory: async () => fakeCoderAdapter('success'),
            githubClientFactory: async () => fakeGithubClient(),
          },
        );

        const agentRuns = await db.query<{ prompt_template_version: string | null }>(
          `SELECT prompt_template_version FROM agent_runs WHERE feature_run_id = ?`,
          [featureRunId],
        );
        expect(agentRuns[0]?.prompt_template_version).toBe('coder-v1');
      },
    );

    it('honors a valid custom prompt template version', async () => {
      process.env[ENV_VAR] = 'coder-v2-custom';

      const db = createTestDb();
      insertTestProject(db, PROJECT_ID);
      const { featureRunId } = await seedCodingFeatureRun(db);
      await registerCoderAdapter(db);

      await runImpl(
        {
          projectId: PROJECT_ID,
          featureRunId,
          correlationId: 'corr-prompt-version-2',
          idempotencyKey: 'idem-prompt-version-2',
          coderAdapterName: 'FakeCoderAdapter',
        },
        db,
        {
          coderAdapterFactory: async () => fakeCoderAdapter('success'),
          githubClientFactory: async () => fakeGithubClient(),
        },
      );

      const agentRuns = await db.query<{ prompt_template_version: string | null }>(
        `SELECT prompt_template_version FROM agent_runs WHERE feature_run_id = ?`,
        [featureRunId],
      );
      expect(agentRuns[0]?.prompt_template_version).toBe('coder-v2-custom');
    });
  });

  describe('required env var validation (LOW-1 code-review fix, round 4)', () => {
    const REQUIRED_ENV_VARS = [
      'GITHUB_TOKEN',
      'CODE_GEN_BASE_URL',
      'CODE_GEN_API_KEY',
      'CODE_GEN_MODEL',
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of REQUIRED_ENV_VARS) {
        savedEnv[key] = process.env[key];
      }
    });

    afterEach(() => {
      for (const key of REQUIRED_ENV_VARS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    it.each(['', '   '])(
      'the default coder adapter factory rejects a whitespace-only GITHUB_TOKEN (%j)',
      async (blankValue) => {
        process.env['GITHUB_TOKEN'] = blankValue;

        const db = createTestDb();
        insertTestProject(db, PROJECT_ID);
        const { featureRunId } = await seedCodingFeatureRun(db);
        await registerCoderAdapter(db);

        await expect(
          runImpl(
            {
              projectId: PROJECT_ID,
              featureRunId,
              correlationId: 'corr-required-env-github-token',
              idempotencyKey: 'idem-required-env-github-token',
              coderAdapterName: 'FakeCoderAdapter',
            },
            db,
            {},
          ),
        ).rejects.toThrow(/GITHUB_TOKEN is not configured/);
      },
    );

    it.each(['CODE_GEN_BASE_URL', 'CODE_GEN_API_KEY', 'CODE_GEN_MODEL'] as const)(
      'the default coder adapter factory rejects a whitespace-only %s',
      async (envVarName) => {
        process.env['GITHUB_TOKEN'] = 'a-real-token';
        process.env['CODE_GEN_BASE_URL'] = 'https://example.invalid';
        process.env['CODE_GEN_API_KEY'] = 'a-real-key';
        process.env['CODE_GEN_MODEL'] = 'a-real-model';
        process.env[envVarName] = '   ';

        const db = createTestDb();
        insertTestProject(db, PROJECT_ID);
        const { featureRunId } = await seedCodingFeatureRun(db);
        await registerCoderAdapter(db);

        await expect(
          runImpl(
            {
              projectId: PROJECT_ID,
              featureRunId,
              correlationId: `corr-required-env-${envVarName}`,
              idempotencyKey: `idem-required-env-${envVarName}`,
              coderAdapterName: 'FakeCoderAdapter',
            },
            db,
            {},
          ),
        ).rejects.toThrow(new RegExp(`${envVarName} is not configured`));
      },
    );

    it('the default github client factory logs a clear error for a whitespace-only GITHUB_TOKEN (PR creation is a swallowed, non-fatal failure)', async () => {
      process.env['GITHUB_TOKEN'] = '  ';
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const db = createTestDb();
      insertTestProject(db, PROJECT_ID);
      const { featureRunId } = await seedCodingFeatureRun(db);
      await registerCoderAdapter(db);

      const result = await runImpl(
        {
          projectId: PROJECT_ID,
          featureRunId,
          correlationId: 'corr-required-env-github-client',
          idempotencyKey: 'idem-required-env-github-client',
          coderAdapterName: 'FakeCoderAdapter',
        },
        db,
        { coderAdapterFactory: async () => fakeCoderAdapter('success') },
      );

      expect(result.pushed).toBe(true);
      expect(result.prNumber).toBeNull();
      const loggedMessages = consoleErrorSpy.mock.calls.map((call) => String(call[1]));
      expect(loggedMessages.some((msg) => msg.includes('GITHUB_TOKEN is not configured'))).toBe(
        true,
      );
      consoleErrorSpy.mockRestore();
    });
  });
});
