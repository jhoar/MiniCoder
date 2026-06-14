import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient, ConfigBackend, SecretBackend } from '@minicoder/core';
import { MissingSecretError } from '@minicoder/core';
import { createTestDb, insertTestProject } from './test-helpers.js';
import { MockTriggerRunner } from './mock-runner.js';
import { getRunByTriggerdevId } from './metadata.js';
import { ALL_TASK_IDS } from './task-ids.js';
import { loadTriggerConfig } from './config.js';

import { runImpl as runPlanningReadiness } from './tasks/planning-readiness-assessment.js';
import { runImpl as runStartClarification } from './tasks/start-clarification.js';
import { runImpl as runGeneratePlan } from './tasks/generate-implementation-plan.js';
import { runImpl as runGenerateBacklog } from './tasks/generate-feature-backlog.js';
import { runImpl as runActivateBacklog } from './tasks/activate-approved-backlog.js';
import { runImpl as runStartNextFeature } from './tasks/start-next-feature.js';
import { runImpl as runGithubReconciliation } from './tasks/github-reconciliation.js';
import { runImpl as runExportPlan } from './tasks/export-plan.js';
import { runImpl as runExportBacklog } from './tasks/export-backlog.js';

const BASE_PAYLOAD = {
  projectId: 'proj-test-001',
  correlationId: 'corr-test-001',
  idempotencyKey: 'idem-test-001',
};

// ── ALL_TASK_IDS ────────────────────────────────────────────────────────────

describe('ALL_TASK_IDS', () => {
  it('exports the 9 canonical task ID strings', () => {
    expect(ALL_TASK_IDS).toHaveLength(9);
    expect(ALL_TASK_IDS).toContain('planning-readiness-assessment');
    expect(ALL_TASK_IDS).toContain('start-clarification');
    expect(ALL_TASK_IDS).toContain('generate-implementation-plan');
    expect(ALL_TASK_IDS).toContain('generate-feature-backlog');
    expect(ALL_TASK_IDS).toContain('activate-approved-backlog');
    expect(ALL_TASK_IDS).toContain('start-next-feature');
    expect(ALL_TASK_IDS).toContain('github-reconciliation');
    expect(ALL_TASK_IDS).toContain('export-plan');
    expect(ALL_TASK_IDS).toContain('export-backlog');
  });
});

// ── MockTriggerRunner DB integration ────────────────────────────────────────

describe('MockTriggerRunner', () => {
  let db: DbClient;
  let runner: MockTriggerRunner;

  beforeEach(() => {
    const testDb = createTestDb();
    insertTestProject(testDb);
    db = testDb;
    runner = new MockTriggerRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('writes triggerdev_runs row and updates status to completed on success', async () => {
    const { runId } = await runner.run(
      'planning-readiness-assessment',
      BASE_PAYLOAD,
      runPlanningReadiness,
    );

    const row = await getRunByTriggerdevId(db, runId);
    expect(row).toBeDefined();
    expect(row?.triggerdev_task_id).toBe('planning-readiness-assessment');
    expect(row?.triggerdev_status).toBe('succeeded');
    expect(row?.project_id).toBe('proj-test-001');
  });

  it('marks run as failed when implementation throws', async () => {
    const boom = async () => {
      throw new Error('simulated failure');
    };

    const runId = 'mock-run-fail-001';
    await expect(runner.run('github-reconciliation', BASE_PAYLOAD, boom, runId)).rejects.toThrow(
      'simulated failure',
    );

    const row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_status).toBe('failed');
  });

  it('retry: same runId upserts the row and succeeds on re-attempt', async () => {
    const runId = 'mock-run-retry-001';
    // First attempt
    await runner.run('export-plan', { ...BASE_PAYLOAD, planId: 'plan-001' }, runExportPlan, runId);
    let row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_status).toBe('succeeded');

    // Retry with same runId: upsert resets status to 'running', impl runs again, status becomes 'succeeded'.
    const retryResult = await runner.run(
      'export-plan',
      { ...BASE_PAYLOAD, planId: 'plan-001' },
      runExportPlan,
      runId,
    );
    expect(retryResult.runId).toBe(runId);
    row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_status).toBe('succeeded');
  });

  it('waitpoint simulation: task pauses on a deferred token then resumes with external approval', async () => {
    let resumeWith!: (approved: boolean) => void;
    const approvalToken = new Promise<boolean>((resolve) => {
      resumeWith = resolve;
    });

    // The task signals the test when it has reached the waitpoint so we can
    // assert it is genuinely blocked before sending the approval.
    let notifyWaiting!: () => void;
    const atWaitpoint = new Promise<void>((resolve) => {
      notifyWaiting = resolve;
    });
    let resumed = false;

    const waitpointTask = async (_payload: typeof BASE_PAYLOAD) => {
      notifyWaiting(); // signal: task is now at the waitpoint
      const approved = await approvalToken; // blocks until externally resolved
      resumed = true;
      return { approved };
    };

    const runPromise = runner.run('activate-approved-backlog', BASE_PAYLOAD, waitpointTask);

    // Wait until the task has signalled it is at the waitpoint — only then send approval.
    await atWaitpoint;
    expect(resumed).toBe(false);

    resumeWith(true);

    const { result } = await runPromise;
    expect(result).toEqual({ approved: true });
    expect(resumed).toBe(true);
  });
});

// ── Task runImpl unit tests (pure, no DB) ──────────────────────────────────

describe('task runImpl — pure unit tests', () => {
  it('planning-readiness-assessment returns a valid readiness result', async () => {
    const result = await runPlanningReadiness(BASE_PAYLOAD);
    expect(result.projectId).toBe('proj-test-001');
    expect(['sufficient', 'sufficient_with_assumptions', 'insufficient']).toContain(
      result.readinessResult,
    );
  });

  it('start-clarification returns a clarification session id', async () => {
    const result = await runStartClarification(BASE_PAYLOAD);
    expect(result.projectId).toBe('proj-test-001');
    expect(typeof result.clarificationSessionId).toBe('string');
  });

  it('generate-implementation-plan returns a plan id', async () => {
    const result = await runGeneratePlan(BASE_PAYLOAD);
    expect(result.planId).toBeTruthy();
  });

  it('generate-feature-backlog returns a numeric feature count', async () => {
    const result = await runGenerateBacklog(BASE_PAYLOAD);
    expect(typeof result.featureCount).toBe('number');
  });

  it('activate-approved-backlog returns activated feature count', async () => {
    const result = await runActivateBacklog({ ...BASE_PAYLOAD, planId: 'plan-001' });
    expect(result.planId).toBe('plan-001');
    expect(typeof result.activatedFeatureCount).toBe('number');
  });

  it('start-next-feature returns started boolean', async () => {
    const result = await runStartNextFeature(BASE_PAYLOAD);
    expect(typeof result.started).toBe('boolean');
  });

  it('github-reconciliation returns numeric reconciled and humanRequired counts', async () => {
    const result = await runGithubReconciliation(BASE_PAYLOAD);
    expect(typeof result.reconciled).toBe('number');
    expect(typeof result.humanRequired).toBe('number');
  });

  it('export-plan returns a non-empty artifact export id', async () => {
    const result = await runExportPlan({ ...BASE_PAYLOAD, planId: 'plan-001' });
    expect(result.artifactExportId).toBeTruthy();
  });

  it('export-backlog returns artifact export id and numeric feature count', async () => {
    const result = await runExportBacklog(BASE_PAYLOAD);
    expect(result.artifactExportId).toBeTruthy();
    expect(typeof result.featureCount).toBe('number');
  });
});

// ── MockTriggerRunner + DB — verifies all 9 tasks write DB rows ─────────────

describe('all 9 tasks write triggerdev_runs rows via MockTriggerRunner', () => {
  let db: DbClient;
  let runner: MockTriggerRunner;

  beforeEach(() => {
    const testDb = createTestDb();
    insertTestProject(testDb);
    db = testDb;
    runner = new MockTriggerRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  const cases: Array<[string, () => Promise<void>]> = [];

  it('planning-readiness-assessment', async () => {
    const { runId } = await runner.run(
      'planning-readiness-assessment',
      BASE_PAYLOAD,
      runPlanningReadiness,
    );
    const row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_task_id).toBe('planning-readiness-assessment');
    expect(row?.triggerdev_status).toBe('succeeded');
  });

  it('start-clarification', async () => {
    const { runId } = await runner.run('start-clarification', BASE_PAYLOAD, runStartClarification);
    const row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_task_id).toBe('start-clarification');
    expect(row?.triggerdev_status).toBe('succeeded');
  });

  it('generate-implementation-plan', async () => {
    const { runId } = await runner.run(
      'generate-implementation-plan',
      BASE_PAYLOAD,
      runGeneratePlan,
    );
    const row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_task_id).toBe('generate-implementation-plan');
    expect(row?.triggerdev_status).toBe('succeeded');
  });

  it('generate-feature-backlog', async () => {
    const { runId } = await runner.run(
      'generate-feature-backlog',
      BASE_PAYLOAD,
      runGenerateBacklog,
    );
    const row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_task_id).toBe('generate-feature-backlog');
    expect(row?.triggerdev_status).toBe('succeeded');
  });

  it('activate-approved-backlog', async () => {
    const { runId } = await runner.run(
      'activate-approved-backlog',
      { ...BASE_PAYLOAD, planId: 'plan-001' },
      runActivateBacklog,
    );
    const row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_task_id).toBe('activate-approved-backlog');
    expect(row?.triggerdev_status).toBe('succeeded');
  });

  it('start-next-feature', async () => {
    const { runId } = await runner.run('start-next-feature', BASE_PAYLOAD, runStartNextFeature);
    const row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_task_id).toBe('start-next-feature');
    expect(row?.triggerdev_status).toBe('succeeded');
  });

  it('github-reconciliation', async () => {
    const { runId } = await runner.run(
      'github-reconciliation',
      BASE_PAYLOAD,
      runGithubReconciliation,
    );
    const row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_task_id).toBe('github-reconciliation');
    expect(row?.triggerdev_status).toBe('succeeded');
  });

  it('export-plan', async () => {
    const { runId } = await runner.run(
      'export-plan',
      { ...BASE_PAYLOAD, planId: 'plan-001' },
      runExportPlan,
    );
    const row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_task_id).toBe('export-plan');
    expect(row?.triggerdev_status).toBe('succeeded');
  });

  it('export-backlog', async () => {
    const { runId } = await runner.run('export-backlog', BASE_PAYLOAD, runExportBacklog);
    const row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_task_id).toBe('export-backlog');
    expect(row?.triggerdev_status).toBe('succeeded');
  });

  // suppress unused variable warning
  void cases;
});

// ── loadTriggerConfig unit tests ─────────────────────────────────────────────

function makeConfig(values: Record<string, string>): ConfigBackend {
  return {
    get: (k) => values[k],
    getRequired: (k) => {
      const v = values[k];
      if (!v) throw new Error(`Required config missing: ${k}`);
      return v;
    },
  };
}

function makeSecrets(values: Record<string, string>): SecretBackend {
  return {
    get: async (k) => {
      const v = values[k];
      if (!v) throw new MissingSecretError(k);
      return v;
    },
    list: async () => [],
  };
}

const VALID_SECRET = 'a'.repeat(64);
const VALID_API_KEY = 'secret-api-key';
const SELF_HOST_URL = 'http://localhost:3040';

describe('loadTriggerConfig', () => {
  it('loads self-host-single-node config with required values', async () => {
    const cfg = await loadTriggerConfig(
      makeConfig({
        TRIGGERDEV_BACKEND: 'self-host-single-node',
        TRIGGERDEV_API_URL: SELF_HOST_URL,
      }),
      makeSecrets({ TRIGGERDEV_API_KEY: VALID_API_KEY, TRIGGERDEV_WEBHOOK_SECRET: VALID_SECRET }),
    );
    expect(cfg.backend).toBe('self-host-single-node');
    expect(cfg.apiUrl).toBe(SELF_HOST_URL);
    expect(cfg.apiKey).toBe(VALID_API_KEY);
    expect(cfg.webhookSecret).toBe(VALID_SECRET);
  });

  it('defaults backend to self-host-single-node when TRIGGERDEV_BACKEND is not set', async () => {
    const cfg = await loadTriggerConfig(
      makeConfig({ TRIGGERDEV_API_URL: SELF_HOST_URL }),
      makeSecrets({ TRIGGERDEV_API_KEY: VALID_API_KEY, TRIGGERDEV_WEBHOOK_SECRET: VALID_SECRET }),
    );
    expect(cfg.backend).toBe('self-host-single-node');
  });

  it('uses cloud URL when backend is cloud', async () => {
    const cfg = await loadTriggerConfig(
      makeConfig({ TRIGGERDEV_BACKEND: 'cloud' }),
      makeSecrets({ TRIGGERDEV_API_KEY: VALID_API_KEY, TRIGGERDEV_WEBHOOK_SECRET: VALID_SECRET }),
    );
    expect(cfg.apiUrl).toBe('https://api.trigger.dev');
  });

  it('throws on invalid TRIGGERDEV_BACKEND value', async () => {
    await expect(
      loadTriggerConfig(
        makeConfig({ TRIGGERDEV_BACKEND: 'invalid-backend', TRIGGERDEV_API_URL: SELF_HOST_URL }),
        makeSecrets({ TRIGGERDEV_API_KEY: VALID_API_KEY, TRIGGERDEV_WEBHOOK_SECRET: VALID_SECRET }),
      ),
    ).rejects.toThrow("Invalid TRIGGERDEV_BACKEND value: 'invalid-backend'");
  });

  it('throws when TRIGGERDEV_API_KEY is missing', async () => {
    await expect(
      loadTriggerConfig(
        makeConfig({ TRIGGERDEV_API_URL: SELF_HOST_URL }),
        makeSecrets({ TRIGGERDEV_WEBHOOK_SECRET: VALID_SECRET }),
      ),
    ).rejects.toBeInstanceOf(MissingSecretError);
  });

  it('throws when TRIGGERDEV_WEBHOOK_SECRET is missing', async () => {
    await expect(
      loadTriggerConfig(
        makeConfig({ TRIGGERDEV_API_URL: SELF_HOST_URL }),
        makeSecrets({ TRIGGERDEV_API_KEY: VALID_API_KEY }),
      ),
    ).rejects.toBeInstanceOf(MissingSecretError);
  });

  it('throws when TRIGGERDEV_WEBHOOK_SECRET is shorter than 64 chars', async () => {
    await expect(
      loadTriggerConfig(
        makeConfig({ TRIGGERDEV_API_URL: SELF_HOST_URL }),
        makeSecrets({ TRIGGERDEV_API_KEY: VALID_API_KEY, TRIGGERDEV_WEBHOOK_SECRET: 'short' }),
      ),
    ).rejects.toThrow('too short');
  });

  it('accepts a webhook secret of exactly 64 chars', async () => {
    const cfg = await loadTriggerConfig(
      makeConfig({ TRIGGERDEV_API_URL: SELF_HOST_URL }),
      makeSecrets({ TRIGGERDEV_API_KEY: VALID_API_KEY, TRIGGERDEV_WEBHOOK_SECRET: 'b'.repeat(64) }),
    );
    expect(cfg.webhookSecret).toHaveLength(64);
  });
});
