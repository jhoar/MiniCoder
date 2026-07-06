import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DbClient,
  ConfigBackend,
  SecretBackend,
  PlannerAgentAdapter,
  CommandEnvelope,
} from '@minicoder/core';
import {
  MissingSecretError,
  FeatureExecutionState,
  GapSeverity,
  TransactionalCommandExecutor,
  SkipFeatureHandler,
  HumanUnblockFeatureHandler,
  type SkipFeaturePayload,
} from '@minicoder/core';
import { ExecutionLane } from '@minicoder/workflow';
import { createTestDb, insertTestProject } from './test-helpers.js';
import { humanActor } from './tasks/actor.js';
import { MockTriggerRunner } from './mock-runner.js';
import { getRunByTriggerdevId } from './metadata.js';
import { ALL_TASK_IDS } from './task-ids.js';
import { loadTriggerConfig } from './config.js';
import { assertSchemaReady } from './db.js';
import { GenerateFeatureBacklogPayload as GenerateFeatureBacklogPayloadSchema } from './tasks/types.js';

import { runImpl as runIngestSpecification } from './tasks/ingest-specification.js';
import { runImpl as runPlanningReadiness } from './tasks/planning-readiness-assessment.js';
import { runImpl as runStartClarification } from './tasks/start-clarification.js';
import { runImpl as runRecordClarificationAnswer } from './tasks/record-clarification-answer.js';
import { runImpl as runCompleteClarification } from './tasks/complete-clarification.js';
import { runImpl as runGeneratePlan } from './tasks/generate-implementation-plan.js';
import { runImpl as runGenerateBacklog } from './tasks/generate-feature-backlog.js';
import { runImpl as runValidateBacklog } from './tasks/validate-backlog.js';
import { runImpl as runRequestPlanApproval } from './tasks/request-plan-approval.js';
import { runImpl as runActivateBacklog } from './tasks/activate-approved-backlog.js';
import { runImpl as runStartNextFeature } from './tasks/start-next-feature.js';
import { runImpl as runGithubReconciliation } from './tasks/github-reconciliation.js';
import { runImpl as runExportPlan } from './tasks/export-plan.js';
import { runImpl as runExportBacklog } from './tasks/export-backlog.js';
import { runImpl as runImportBacklog } from './tasks/import-backlog.js';

const BASE_PAYLOAD = {
  projectId: 'proj-test-001',
  correlationId: 'corr-test-001',
  idempotencyKey: 'idem-test-001',
};

const ACTOR = { actorId: 'test-operator', actorRole: 'operator' as const };
const APPROVER = { actorId: 'test-approver', actorRole: 'approver' as const };

/** Deterministic fake planner used for wiring tests — never imports @minicoder/testing (see resolveDefaultPlannerAdapter). */
function fakePlanner(
  readinessResult: 'sufficient' | 'insufficient' = 'sufficient',
): PlannerAgentAdapter {
  return {
    role: 'PlannerAgentAdapter',
    async run() {
      return {
        readinessResult,
        questions:
          readinessResult === 'insufficient' ? [{ question: 'What is the scope?', round: 1 }] : [],
        assumptions: [],
        gaps: [],
      };
    },
  };
}

async function registerMockPlanner(db: DbClient, name = 'MockPlannerAdapter'): Promise<void> {
  const now = new Date().toISOString();
  const adapterId = `adapter-${name}`;
  await db.execute(
    `INSERT INTO agent_adapters (id, role, name, implementation, is_active, version, created_at, updated_at)
     VALUES (?, 'PlannerAgentAdapter', ?, 'test:FakePlanner', 1, 1, ?, ?)`,
    [adapterId, name, now, now],
  );
  await db.execute(
    `INSERT INTO agent_capabilities (id, adapter_id, capability, created_at) VALUES (?, ?, ?, ?)`,
    [`${adapterId}-cap`, adapterId, 'can_generate_plan', now],
  );
}

// ── ALL_TASK_IDS ────────────────────────────────────────────────────────────

describe('ALL_TASK_IDS', () => {
  it("exports the 18 canonical task ID strings (15 from Phases 3/6/7 plus Phase 9's run-coder, Phase 10's run-review, and Phase 12's run-merge-gate)", () => {
    expect(ALL_TASK_IDS).toHaveLength(18);
    expect(ALL_TASK_IDS).toContain('ingest-specification');
    expect(ALL_TASK_IDS).toContain('planning-readiness-assessment');
    expect(ALL_TASK_IDS).toContain('start-clarification');
    expect(ALL_TASK_IDS).toContain('record-clarification-answer');
    expect(ALL_TASK_IDS).toContain('complete-clarification');
    expect(ALL_TASK_IDS).toContain('generate-implementation-plan');
    expect(ALL_TASK_IDS).toContain('generate-feature-backlog');
    expect(ALL_TASK_IDS).toContain('validate-backlog');
    expect(ALL_TASK_IDS).toContain('request-plan-approval');
    expect(ALL_TASK_IDS).toContain('activate-approved-backlog');
    expect(ALL_TASK_IDS).toContain('start-next-feature');
    expect(ALL_TASK_IDS).toContain('run-coder');
    expect(ALL_TASK_IDS).toContain('run-review');
    expect(ALL_TASK_IDS).toContain('run-merge-gate');
    expect(ALL_TASK_IDS).toContain('github-reconciliation');
    expect(ALL_TASK_IDS).toContain('export-plan');
    expect(ALL_TASK_IDS).toContain('export-backlog');
    expect(ALL_TASK_IDS).toContain('import-backlog');
  });

  // HIGH-1 code-review fix (Phase 10 PR review): run-review was added to ALL_TASK_IDS with a
  // runImpl/payload schema/tests, but was never registered as a Trigger.dev SDK task in
  // triggerdev-tasks.ts, so a live deployment would never schedule it. A static source scan (not
  // an import — @trigger.dev/sdk/v3's `task()` requires a live Trigger.dev context this unit test
  // doesn't have) keeps every ALL_TASK_IDS entry synchronized with an actual `task({ id: ... })`
  // registration going forward.
  it('every ALL_TASK_IDS entry has a corresponding task({ id: ... }) registration in triggerdev-tasks.ts', () => {
    const source = readFileSync(join(__dirname, 'triggerdev-tasks.ts'), 'utf-8');
    for (const taskId of ALL_TASK_IDS) {
      expect(source, `missing task registration for '${taskId}'`).toContain(`id: '${taskId}'`);
    }
  });
});

// ── MockTriggerRunner DB integration ────────────────────────────────────────

describe('MockTriggerRunner', () => {
  let db: DbClient;
  let runner: MockTriggerRunner;

  beforeEach(async () => {
    const testDb = createTestDb();
    insertTestProject(testDb);
    db = testDb;
    runner = new MockTriggerRunner(db);
    await registerMockPlanner(db);
  });

  it('writes triggerdev_runs row and updates status to completed on success', async () => {
    const { runId } = await runner.run(
      'planning-readiness-assessment',
      {
        ...BASE_PAYLOAD,
        specificationContent: 'Build a todo app.',
        plannerAdapterName: 'MockPlannerAdapter',
      },
      runPlanningReadiness,
      undefined,
      fakePlanner(),
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
    const payload = {
      ...BASE_PAYLOAD,
      ...ACTOR,
      content: 'Build a todo app.',
      contentType: 'text/plain',
    };
    // First attempt
    await runner.run('ingest-specification', payload, runIngestSpecification, runId);
    let row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_status).toBe('succeeded');

    // Retry with same runId: upsert resets status to 'running', impl runs again, status becomes 'succeeded'.
    const retryResult = await runner.run(
      'ingest-specification',
      { ...payload, idempotencyKey: `${payload.idempotencyKey}-retry` },
      runIngestSpecification,
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

// ── Task runImpl unit tests (against a real test DB — these commands write domain state) ──

describe('task runImpl — command-backed unit tests', () => {
  let db: DbClient;

  beforeEach(async () => {
    const testDb = createTestDb();
    insertTestProject(testDb);
    db = testDb;
    await registerMockPlanner(db);
  });

  it('ingest-specification records a specification_inputs row', async () => {
    const result = await runIngestSpecification(
      { ...BASE_PAYLOAD, ...ACTOR, content: 'Build a todo app.', contentType: 'text/plain' },
      db,
    );
    expect(result.projectId).toBe('proj-test-001');
  });

  it('planning-readiness-assessment returns a valid readiness result', async () => {
    const result = await runPlanningReadiness(
      {
        ...BASE_PAYLOAD,
        specificationContent: 'Build a todo app.',
        plannerAdapterName: 'MockPlannerAdapter',
      },
      db,
      fakePlanner('sufficient'),
    );
    expect(result.projectId).toBe('proj-test-001');
    expect(['sufficient', 'sufficient_with_assumptions', 'insufficient']).toContain(
      result.readinessResult,
    );
  });

  it('generate-implementation-plan returns a plan id once the assessment is sufficient', async () => {
    const assessment = await runPlanningReadiness(
      {
        ...BASE_PAYLOAD,
        specificationContent: 'Build a todo app.',
        plannerAdapterName: 'MockPlannerAdapter',
      },
      db,
      fakePlanner('sufficient'),
    );
    expect(assessment.readinessResult).toBe('sufficient');

    const assessmentRows = await db.query<{ id: string }>(
      `SELECT id FROM planning_readiness_assessments WHERE project_id = ?`,
      ['proj-test-001'],
    );
    const assessmentId = assessmentRows[0]!.id;

    const result = await runGeneratePlan(
      {
        ...BASE_PAYLOAD,
        assessmentId,
        title: 'Todo App Plan',
        summary: 'A minimal todo app',
        sections: [{ title: 'Overview', content: 'Build CRUD endpoints.' }],
      },
      db,
    );
    expect(result.planId).toBeTruthy();
  });

  it('generate-feature-backlog rejects when the plan does not exist', async () => {
    await expect(
      runGenerateBacklog(
        {
          ...BASE_PAYLOAD,
          planId: 'plan-missing',
          features: [
            {
              frId: 'FR-001',
              title: 'Create todo',
              description: 'Allow creating a todo item.',
              kind: 'feature' as const,
              priority: 0,
              dependsOnFrIds: [],
              acceptanceCriteria: [],
              testExpectations: [],
            },
          ],
        },
        db,
      ),
    ).rejects.toThrow('not found');
  });

  it('generate-feature-backlog payload schema rejects an empty features array', () => {
    const parsed = GenerateFeatureBacklogPayloadSchema.safeParse({
      ...BASE_PAYLOAD,
      planId: 'plan-001',
      features: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('start-next-feature returns started boolean and no-ops when no candidate exists', async () => {
    const result = await runStartNextFeature(BASE_PAYLOAD, db);
    expect(typeof result.started).toBe('boolean');
    expect(result.started).toBe(false);
    expect(result.featureRunId).toBeNull();
  });

  it('github-reconciliation returns numeric reconciled and humanRequired counts', async () => {
    const result = await runGithubReconciliation(BASE_PAYLOAD, db);
    expect(typeof result.reconciled).toBe('number');
    expect(typeof result.humanRequired).toBe('number');
  });
});

// ── start-next-feature real wiring (Phase 8) ────────────────────────────────

async function seedExecutionOrchestratorFixture(db: DbClient, projectId: string): Promise<void> {
  const planId = `plan-${projectId}`;
  const frId = `fr-${projectId}-1`;
  const runId = `run-${projectId}-1`;

  await db.execute(
    `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
    [planId, projectId],
  );
  await db.execute(
    `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
     VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, ?, 0, 1, datetime('now'), datetime('now'))`,
    [frId, planId, projectId, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
  );
  await db.execute(
    `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
     VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
    [runId, frId, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
  );
  await db.execute(
    `INSERT INTO workflow_states (id, project_id, active_feature_run_id, automation_state, version, created_at, updated_at)
     VALUES (?, ?, NULL, 'running', 1, datetime('now'), datetime('now'))`,
    [`ws-${projectId}`, projectId],
  );
}

describe('start-next-feature real wiring', () => {
  let db: DbClient;
  const projectId = 'proj-snf-wiring';

  beforeEach(async () => {
    const testDb = createTestDb();
    insertTestProject(testDb, projectId);
    db = testDb;
    await seedExecutionOrchestratorFixture(db, projectId);
  });

  it('selects the eligible feature run and starts coding', async () => {
    const result = await runStartNextFeature(
      { projectId, correlationId: 'corr-snf', idempotencyKey: 'idem-snf-1' },
      db,
    );
    expect(result.started).toBe(true);
    expect(result.featureRunId).toBe(`run-${projectId}-1`);

    const rows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [`run-${projectId}-1`],
    );
    expect(rows[0]?.current_execution_state).toBe(FeatureExecutionState.CODING);
  });

  it('does not start a second feature while one is already active', async () => {
    await runStartNextFeature(
      { projectId, correlationId: 'corr-snf', idempotencyKey: 'idem-snf-1' },
      db,
    );
    const second = await runStartNextFeature(
      { projectId, correlationId: 'corr-snf', idempotencyKey: 'idem-snf-2' },
      db,
    );
    expect(second.started).toBe(false);
  });

  it('no-ops without mutating state when automation is paused', async () => {
    await db.execute(
      `UPDATE workflow_states SET automation_state = 'paused_by_operator' WHERE project_id = ?`,
      [projectId],
    );
    const result = await runStartNextFeature(
      { projectId, correlationId: 'corr-snf', idempotencyKey: 'idem-snf-3' },
      db,
    );
    expect(result.started).toBe(false);
    const rows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [`run-${projectId}-1`],
    );
    expect(rows[0]?.current_execution_state).toBe(FeatureExecutionState.APPROVED_PENDING_EXECUTION);
  });

  // HIGH-1 (Phase 8 code review round 3): a pause/budget-pause landing between
  // SelectFeatureCommand succeeding and StartCodingCommand dispatching used to strand the
  // project — findNextEligibleFeatureRun only looks for approved_pending_execution rows, so the
  // already-selected active feature run was never surfaced again once automation resumed.
  it.each([
    ['paused_by_operator' as const],
    ['paused_budget_exceeded' as const],
    ['waiting_for_budget_approval' as const],
  ])(
    'recovers a feature run stranded at selected after automation resumes from %s',
    async (pausedState) => {
      const featureRunId = `run-${projectId}-1`;

      // Simulate SelectFeatureCommand having already succeeded (active_feature_run_id set,
      // feature run at 'selected') before automation was paused/budget-paused, stranding it
      // before StartCodingCommand could run.
      await db.execute(
        `UPDATE feature_runs SET current_execution_state = 'selected', version = version + 1 WHERE id = ?`,
        [featureRunId],
      );
      await db.execute(
        `UPDATE workflow_states SET active_feature_run_id = ?, automation_state = ?, version = version + 1 WHERE project_id = ?`,
        [featureRunId, pausedState, projectId],
      );

      // A scheduled call while still paused must not start coding and must not lose the stranded
      // run's identity.
      const whilePaused = await runStartNextFeature(
        { projectId, correlationId: 'corr-snf', idempotencyKey: 'idem-snf-paused' },
        db,
      );
      expect(whilePaused.started).toBe(false);
      expect(whilePaused.featureRunId).toBe(featureRunId);
      const stillSelected = await db.query<{ current_execution_state: string }>(
        `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
        [featureRunId],
      );
      expect(stillSelected[0]?.current_execution_state).toBe(FeatureExecutionState.SELECTED);

      // Automation resumes (operator resume or budget override, depending on which state).
      await db.execute(
        `UPDATE workflow_states SET automation_state = 'running', version = version + 1 WHERE project_id = ?`,
        [projectId],
      );

      const afterResume = await runStartNextFeature(
        { projectId, correlationId: 'corr-snf', idempotencyKey: 'idem-snf-resumed' },
        db,
      );
      expect(afterResume.started).toBe(true);
      expect(afterResume.featureRunId).toBe(featureRunId);
      const codingRows = await db.query<{ current_execution_state: string }>(
        `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
        [featureRunId],
      );
      expect(codingRows[0]?.current_execution_state).toBe(FeatureExecutionState.CODING);
    },
  );

  // A concurrent holder of the project's execution lane (a github-reconciliation pass, an
  // overlapping retry, or an HA-cluster peer) makes lane acquisition throw LockConflictError.
  // That is an expected race — the task must return started:false, not surface a Trigger.dev
  // failure. SelectFeatureCommand still runs first (it takes no lock), so the feature run is left
  // at 'selected'; a later tick recovers it via the stranded-selected path once the lane frees.
  it('returns started:false without failing when the execution lane is held by another worker', async () => {
    const featureRunId = `run-${projectId}-1`;

    // A foreign holder grabs the execution lane before start-next-feature runs.
    const foreignLane = new ExecutionLane(db);
    const foreignLock = await foreignLane.acquireForProject(projectId, 'foreign-holder', 30_000);

    const blocked = await runStartNextFeature(
      { projectId, correlationId: 'corr-snf', idempotencyKey: 'idem-snf-lockheld' },
      db,
    );
    expect(blocked.started).toBe(false);
    expect(blocked.featureRunId).toBe(featureRunId);

    // Selection succeeded (no lock needed) but coding was blocked by the held lane, so the run is
    // parked at 'selected' with the active pointer set.
    const selectedRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(selectedRows[0]?.current_execution_state).toBe(FeatureExecutionState.SELECTED);

    // The lane frees; the next scheduled tick recovers the stranded selected run and starts coding.
    await foreignLane.releaseForProject(foreignLock);
    const recovered = await runStartNextFeature(
      { projectId, correlationId: 'corr-snf', idempotencyKey: 'idem-snf-lockfree' },
      db,
    );
    expect(recovered.started).toBe(true);
    expect(recovered.featureRunId).toBe(featureRunId);
    const codingRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(codingRows[0]?.current_execution_state).toBe(FeatureExecutionState.CODING);
  });

  // HIGH-1 (Phase 8 code review round 6): the stranded-selected recovery previously only ran
  // when payload.featureRunId was omitted. An explicit caller naming the project's already-
  // selected active run directly (e.g. a targeted retry) would still attempt an invalid
  // 'selected -> selected' SelectFeatureCommand, throwing an uncaught TransitionError instead of
  // recovering and starting coding.
  it('recovers a stranded selected run when the caller explicitly names it', async () => {
    const featureRunId = `run-${projectId}-1`;

    await db.execute(
      `UPDATE feature_runs SET current_execution_state = 'selected', version = version + 1 WHERE id = ?`,
      [featureRunId],
    );
    await db.execute(
      `UPDATE workflow_states SET active_feature_run_id = ?, version = version + 1 WHERE project_id = ?`,
      [featureRunId, projectId],
    );

    const result = await runStartNextFeature(
      { projectId, correlationId: 'corr-snf', idempotencyKey: 'idem-snf-explicit', featureRunId },
      db,
    );
    expect(result.started).toBe(true);
    expect(result.featureRunId).toBe(featureRunId);

    const rows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    expect(rows[0]?.current_execution_state).toBe(FeatureExecutionState.CODING);
  });
});

// ── Issue #52: SkipFeatureCommand cascades a blocked transition to dependents ──────────────

describe('SkipFeatureCommand cascading dependency guard (issue #52)', () => {
  const projectId = 'proj-skip-cascade';

  async function seedFixture(db: DbClient): Promise<{
    skippedRunId: string;
    dependentRunId: string;
  }> {
    const planId = `plan-${projectId}`;
    const targetFrId = `fr-${projectId}-target`;
    const sourceFrId = `fr-${projectId}-source`;
    const skippedRunId = `run-${projectId}-target`;
    const dependentRunId = `run-${projectId}-source`;

    await db.execute(
      `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );
    await db.execute(
      `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-TARGET', 'Target feature', 'Description', 'feature', 1, ?, 0, 1, datetime('now'), datetime('now'))`,
      [targetFrId, planId, projectId, FeatureExecutionState.HUMAN_REQUIRED],
    );
    await db.execute(
      `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-SOURCE', 'Dependent feature', 'Description', 'feature', 1, ?, 0, 1, datetime('now'), datetime('now'))`,
      [sourceFrId, planId, projectId, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
    );
    await db.execute(
      `INSERT INTO feature_dependencies (id, source_fr_id, target_fr_id, created_at) VALUES (?, ?, ?, datetime('now'))`,
      [`dep-${projectId}`, sourceFrId, targetFrId],
    );
    await db.execute(
      `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
      [skippedRunId, targetFrId, FeatureExecutionState.HUMAN_REQUIRED],
    );
    await db.execute(
      `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
      [dependentRunId, sourceFrId, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
    );
    return { skippedRunId, dependentRunId };
  }

  it('transitions a dependent feature run at approved_pending_execution to blocked when its dependency is skipped', async () => {
    const db = createTestDb();
    insertTestProject(db, projectId);
    const { skippedRunId, dependentRunId } = await seedFixture(db);

    const executor = new TransactionalCommandExecutor(db);
    const handler = new SkipFeatureHandler();
    const envelope: CommandEnvelope<SkipFeaturePayload> = {
      commandId: 'cmd-skip-1',
      idempotencyKey: 'idem-skip-1',
      payload: {
        featureRunId: skippedRunId,
        projectId,
        expectedVersion: 1,
        notes: 'Cannot be resolved; abandoning automation.',
      },
      actor: humanActor({ actorId: 'operator-1', actorRole: 'approver', correlationId: 'corr-1' }),
      correlationId: 'corr-1',
    };
    await executor.execute(handler, envelope);

    const skippedRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [skippedRunId],
    );
    expect(skippedRows[0]?.current_execution_state).toBe(FeatureExecutionState.SKIPPED);

    const dependentRows = await db.query<{ current_execution_state: string; version: number }>(
      `SELECT current_execution_state, version FROM feature_runs WHERE id = ?`,
      [dependentRunId],
    );
    expect(dependentRows[0]?.current_execution_state).toBe(FeatureExecutionState.BLOCKED);
    expect(dependentRows[0]?.version).toBe(2);

    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM workflow_events WHERE feature_run_id = ? ORDER BY created_at`,
      [dependentRunId],
    );
    expect(events.map((e) => e.event_type)).toContain('feature.blocked_by_skipped_dependency');
  });

  it('does not touch a dependent that is not at approved_pending_execution', async () => {
    const db = createTestDb();
    insertTestProject(db, projectId);
    const { skippedRunId, dependentRunId } = await seedFixture(db);
    await db.execute(
      `UPDATE feature_runs SET current_execution_state = 'coding', version = version + 1 WHERE id = ?`,
      [dependentRunId],
    );

    const executor = new TransactionalCommandExecutor(db);
    const handler = new SkipFeatureHandler();
    await executor.execute(handler, {
      commandId: 'cmd-skip-2',
      idempotencyKey: 'idem-skip-2',
      payload: {
        featureRunId: skippedRunId,
        projectId,
        expectedVersion: 1,
        notes: 'Cannot be resolved; abandoning automation.',
      },
      actor: humanActor({ actorId: 'operator-1', actorRole: 'approver', correlationId: 'corr-2' }),
      correlationId: 'corr-2',
    });

    const dependentRows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [dependentRunId],
    );
    expect(dependentRows[0]?.current_execution_state).toBe('coding');
  });
});

// ── Issue #53: HumanUnblockFeatureCommand ──────────────────────────────────

describe('HumanUnblockFeatureCommand (issue #53)', () => {
  const projectId = 'proj-human-unblock';

  it('transitions a human-blocked feature run back to approved_pending_execution', async () => {
    const db = createTestDb();
    insertTestProject(db, projectId);
    const planId = `plan-${projectId}`;
    const frId = `fr-${projectId}`;
    const runId = `run-${projectId}`;
    await db.execute(
      `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );
    await db.execute(
      `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-001', 'Feature', 'Description', 'feature', 1, 'blocked', 0, 1, datetime('now'), datetime('now'))`,
      [frId, planId, projectId],
    );
    await db.execute(
      `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
      [runId, frId, FeatureExecutionState.BLOCKED],
    );

    const executor = new TransactionalCommandExecutor(db);
    const result = await executor.execute(new HumanUnblockFeatureHandler(), {
      commandId: 'cmd-unblock-1',
      idempotencyKey: 'idem-unblock-1',
      payload: {
        featureRunId: runId,
        projectId,
        expectedVersion: 1,
        notes: 'The external API key has been provisioned; automation may resume.',
      },
      actor: humanActor({ actorId: 'approver-1', actorRole: 'approver', correlationId: 'corr-1' }),
      correlationId: 'corr-1',
    });
    expect(result.resultingState).toBe(FeatureExecutionState.APPROVED_PENDING_EXECUTION);

    const rows = await db.query<{ current_execution_state: string }>(
      `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
      [runId],
    );
    expect(rows[0]?.current_execution_state).toBe(FeatureExecutionState.APPROVED_PENDING_EXECUTION);

    const approvals = await db.query<{ decision: string; context_type: string }>(
      `SELECT decision, context_type FROM human_approvals WHERE feature_run_id = ?`,
      [runId],
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.decision).toBe('approved');
  });

  it('rejects unblocking a feature run that is not currently blocked', async () => {
    const db = createTestDb();
    insertTestProject(db, projectId);
    const planId = `plan-${projectId}-2`;
    const frId = `fr-${projectId}-2`;
    const runId = `run-${projectId}-2`;
    await db.execute(
      `INSERT INTO implementation_plans (id, project_id, assessment_id, state, title, summary, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'activated_for_execution', 'Plan', 'Summary', 1, datetime('now'), datetime('now'))`,
      [planId, projectId],
    );
    await db.execute(
      `INSERT INTO feature_requests (id, plan_id, project_id, fr_id, title, description, kind, executable, state, priority, version, created_at, updated_at)
       VALUES (?, ?, ?, 'FR-002', 'Feature', 'Description', 'feature', 1, 'approved_pending_execution', 0, 1, datetime('now'), datetime('now'))`,
      [frId, planId, projectId],
    );
    await db.execute(
      `INSERT INTO feature_runs (id, feature_request_id, attempt_no, current_execution_state, version, created_at, updated_at)
       VALUES (?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
      [runId, frId, FeatureExecutionState.APPROVED_PENDING_EXECUTION],
    );

    const executor = new TransactionalCommandExecutor(db);
    await expect(
      executor.execute(new HumanUnblockFeatureHandler(), {
        commandId: 'cmd-unblock-2',
        idempotencyKey: 'idem-unblock-2',
        payload: {
          featureRunId: runId,
          projectId,
          expectedVersion: 1,
          notes: 'Should not be allowed.',
        },
        actor: humanActor({
          actorId: 'approver-1',
          actorRole: 'approver',
          correlationId: 'corr-2',
        }),
        correlationId: 'corr-2',
      }),
    ).rejects.toThrow();
  });
});

// ── Code-review regression tests (HIGH-1, HIGH-2, MEDIUM-2) ────────────────

describe('backlog validation gate (HIGH-1) and error propagation (HIGH-2, MEDIUM-2)', () => {
  let db: DbClient;

  beforeEach(async () => {
    const testDb = createTestDb();
    insertTestProject(testDb);
    db = testDb;
    await registerMockPlanner(db);
  });

  /** Creates a draft plan with one feature request, returning its id/version. */
  async function setupPlanWithBacklog(): Promise<{ planId: string; planVersion: number }> {
    const assessment = await runPlanningReadiness(
      {
        ...BASE_PAYLOAD,
        specificationContent: 'Build a todo app.',
        plannerAdapterName: 'MockPlannerAdapter',
      },
      db,
      fakePlanner('sufficient'),
    );
    expect(assessment.readinessResult).toBe('sufficient');
    const assessmentRows = await db.query<{ id: string }>(
      `SELECT id FROM planning_readiness_assessments WHERE project_id = ?`,
      ['proj-test-001'],
    );
    await runGeneratePlan(
      {
        ...BASE_PAYLOAD,
        assessmentId: assessmentRows[0]!.id,
        title: 'Todo App Plan',
        sections: [{ title: 'Overview', content: 'Build CRUD endpoints.' }],
      },
      db,
    );
    const planRows = await db.query<{ id: string; version: number }>(
      `SELECT id, version FROM implementation_plans WHERE project_id = ?`,
      ['proj-test-001'],
    );
    const plan = planRows[0]!;
    await runGenerateBacklog(
      {
        ...BASE_PAYLOAD,
        planId: plan.id,
        features: [
          {
            frId: 'FR-001',
            title: 'Create todo',
            description: 'Allow creating a todo item.',
            kind: 'feature' as const,
            priority: 0,
            dependsOnFrIds: [],
            acceptanceCriteria: ['A user can create a todo.'],
            testExpectations: [
              { description: 'Creating a todo persists it.', testType: 'unit' as const },
            ],
          },
        ],
      },
      db,
    );
    return { planId: plan.id, planVersion: plan.version };
  }

  it('HIGH-1: request-plan-approval rejects a plan that was never validated', async () => {
    const { planId, planVersion } = await setupPlanWithBacklog();
    await expect(
      runRequestPlanApproval(
        { ...BASE_PAYLOAD, ...ACTOR, planId, expectedVersion: planVersion },
        db,
      ),
    ).rejects.toThrow('backlog');
  });

  it('HIGH-1: request-plan-approval rejects a plan whose validation is stale (backlog regenerated after validating)', async () => {
    const { planId, planVersion } = await setupPlanWithBacklog();
    await runValidateBacklog({ ...BASE_PAYLOAD, planId }, db);

    // Regenerating the backlog resets backlog_validated_state, invalidating the prior 'valid' result.
    // Use a distinct idempotencyKey so this call re-executes instead of replaying the cached
    // result from setupPlanWithBacklog()'s first generate-feature-backlog call.
    await runGenerateBacklog(
      {
        ...BASE_PAYLOAD,
        idempotencyKey: 'idem-test-001-regenerate',
        planId,
        features: [
          {
            frId: 'FR-002',
            title: 'Delete todo',
            description: 'Allow deleting a todo item.',
            kind: 'feature' as const,
            priority: 0,
            dependsOnFrIds: [],
            acceptanceCriteria: ['A user can delete a todo.'],
            testExpectations: [
              { description: 'Deleting removes the todo.', testType: 'unit' as const },
            ],
          },
        ],
      },
      db,
    );

    await expect(
      runRequestPlanApproval(
        { ...BASE_PAYLOAD, ...ACTOR, planId, expectedVersion: planVersion },
        db,
      ),
    ).rejects.toThrow('backlog');
  });

  it('HIGH-1: request-plan-approval accepts a plan validated against its current backlog', async () => {
    const { planId, planVersion } = await setupPlanWithBacklog();
    const validation = await runValidateBacklog({ ...BASE_PAYLOAD, planId }, db);
    expect(validation.valid).toBe(true);

    const result = await runRequestPlanApproval(
      { ...BASE_PAYLOAD, ...ACTOR, planId, expectedVersion: planVersion },
      db,
    );
    expect(result.planId).toBe(planId);
  });

  // Issue #31: SubmitPlanForApprovalCommand's blocking-gap check used to join through
  // planning_readiness_assessments.project_id, blocking submission on *any* unresolved blocking
  // gap anywhere in the project — even one tied to a completely different assessment than the one
  // the plan being submitted was generated from. Fixed to scope by the plan's own assessment_id.
  it('#31: a blocking gap on a different assessment does not block submitting a plan from this assessment', async () => {
    async function setupPlanFromFreshAssessment(
      idemPrefix: string,
      title: string,
    ): Promise<{ planId: string; planVersion: number; assessmentId: string }> {
      await runPlanningReadiness(
        {
          ...BASE_PAYLOAD,
          idempotencyKey: `${idemPrefix}-readiness`,
          correlationId: `${idemPrefix}-corr`,
          specificationContent: `Build ${title}.`,
          plannerAdapterName: 'MockPlannerAdapter',
        },
        db,
        fakePlanner('sufficient'),
      );
      const assessmentRows = await db.query<{ id: string }>(
        `SELECT id FROM planning_readiness_assessments WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        ['proj-test-001'],
      );
      const assessmentId = assessmentRows[0]!.id;
      await runGeneratePlan(
        {
          ...BASE_PAYLOAD,
          idempotencyKey: `${idemPrefix}-plan`,
          assessmentId,
          title,
          sections: [{ title: 'Overview', content: 'Build CRUD endpoints.' }],
        },
        db,
      );
      const planRows = await db.query<{ id: string; version: number }>(
        `SELECT id, version FROM implementation_plans WHERE assessment_id = ?`,
        [assessmentId],
      );
      const plan = planRows[0]!;
      await runGenerateBacklog(
        {
          ...BASE_PAYLOAD,
          idempotencyKey: `${idemPrefix}-backlog`,
          planId: plan.id,
          features: [
            {
              frId: `FR-${idemPrefix}-001`,
              title: 'Create item',
              description: 'Allow creating an item.',
              kind: 'feature' as const,
              priority: 0,
              dependsOnFrIds: [],
              acceptanceCriteria: ['A user can create an item.'],
              testExpectations: [
                { description: 'Creating an item persists it.', testType: 'unit' as const },
              ],
            },
          ],
        },
        db,
      );
      await runValidateBacklog(
        { ...BASE_PAYLOAD, idempotencyKey: `${idemPrefix}-validate`, planId: plan.id },
        db,
      );
      return { planId: plan.id, planVersion: plan.version, assessmentId };
    }

    const planA = await setupPlanFromFreshAssessment('a31a', 'Plan A');
    const planB = await setupPlanFromFreshAssessment('a31b', 'Plan B');

    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO planning_gaps (id, assessment_id, description, severity, resolved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ['gap-a', planA.assessmentId, 'Gap on assessment A', GapSeverity.BLOCKING, now, now],
    );
    await db.execute(
      `INSERT INTO planning_gaps (id, assessment_id, description, severity, resolved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ['gap-b', planB.assessmentId, 'Gap on assessment B', GapSeverity.BLOCKING, now, now],
    );

    // Plan A is blocked by its own assessment's unresolved gap.
    await expect(
      runRequestPlanApproval(
        {
          ...BASE_PAYLOAD,
          ...ACTOR,
          idempotencyKey: 'a31-submit-a-blocked',
          planId: planA.planId,
          expectedVersion: planA.planVersion,
        },
        db,
      ),
    ).rejects.toThrow(/blocking gap/i);

    // Resolving assessment A's gap allows plan A to submit, even though assessment B's gap is
    // still unresolved — proving the check is assessment-scoped, not project-scoped.
    await db.execute(`UPDATE planning_gaps SET resolved_at = ? WHERE id = ?`, [now, 'gap-a']);

    const result = await runRequestPlanApproval(
      {
        ...BASE_PAYLOAD,
        ...ACTOR,
        idempotencyKey: 'a31-submit-a-allowed',
        planId: planA.planId,
        expectedVersion: planA.planVersion,
      },
      db,
    );
    expect(result.planId).toBe(planA.planId);
  });

  it('HIGH-2: validate-backlog task rethrows non-backlog-invalid errors instead of returning valid:false', async () => {
    // A plan with no feature_requests throws a CommandError of type 'empty-backlog' (not
    // 'backlog-invalid'), which the task must propagate rather than swallow as { valid: false }.
    await expect(
      runValidateBacklog({ ...BASE_PAYLOAD, planId: 'plan-missing' }, db),
    ).rejects.toThrow('no feature requests to validate');
  });

  it('MEDIUM-2: complete-clarification cannot reopen a round while current-round questions are unanswered', async () => {
    const assessment = await runPlanningReadiness(
      {
        ...BASE_PAYLOAD,
        specificationContent: 'Build something awesome.',
        plannerAdapterName: 'MockPlannerAdapter',
      },
      db,
      fakePlanner('insufficient'),
    );
    expect(assessment.readinessResult).toBe('insufficient');

    const sessionRows = await db.query<{ id: string; version: number }>(
      `SELECT id, version FROM clarification_sessions WHERE project_id = ?`,
      ['proj-test-001'],
    );
    const session = sessionRows[0]!;
    await runStartClarification(
      {
        ...BASE_PAYLOAD,
        ...ACTOR,
        clarificationSessionId: session.id,
        expectedVersion: session.version,
      },
      db,
    );

    // Deliberately leave the round's question(s) unanswered, then try to reopen another round.
    const updatedSessionRows = await db.query<{ version: number }>(
      `SELECT version FROM clarification_sessions WHERE id = ?`,
      [session.id],
    );
    await expect(
      runCompleteClarification(
        {
          ...BASE_PAYLOAD,
          ...ACTOR,
          clarificationSessionId: session.id,
          expectedVersion: updatedSessionRows[0]!.version,
          readinessResult: 'insufficient',
        },
        db,
      ),
    ).rejects.toThrow('unanswered');
  });
});

// ── MockTriggerRunner + DB — verifies all 15 tasks write DB rows ────────────

describe('all 15 tasks write triggerdev_runs rows via MockTriggerRunner', () => {
  let db: DbClient;
  let runner: MockTriggerRunner;

  beforeEach(async () => {
    const testDb = createTestDb();
    insertTestProject(testDb);
    db = testDb;
    runner = new MockTriggerRunner(db);
    await registerMockPlanner(db);
  });

  it('ingest-specification', async () => {
    const { runId } = await runner.run(
      'ingest-specification',
      { ...BASE_PAYLOAD, ...ACTOR, content: 'Build a todo app.', contentType: 'text/plain' },
      runIngestSpecification,
    );
    const row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_task_id).toBe('ingest-specification');
    expect(row?.triggerdev_status).toBe('succeeded');
  });

  it('planning-readiness-assessment', async () => {
    const { runId } = await runner.run(
      'planning-readiness-assessment',
      {
        ...BASE_PAYLOAD,
        specificationContent: 'Build a todo app.',
        plannerAdapterName: 'MockPlannerAdapter',
      },
      runPlanningReadiness,
      undefined,
      fakePlanner(),
    );
    const row = await getRunByTriggerdevId(db, runId);
    expect(row?.triggerdev_task_id).toBe('planning-readiness-assessment');
    expect(row?.triggerdev_status).toBe('succeeded');
  });

  it('start-clarification, record-clarification-answer, complete-clarification', async () => {
    const assessment = await runPlanningReadiness(
      {
        ...BASE_PAYLOAD,
        specificationContent: 'Build a todo app.',
        plannerAdapterName: 'MockPlannerAdapter',
      },
      db,
      fakePlanner('insufficient'),
    );
    expect(assessment.readinessResult).toBe('insufficient');

    const sessionRows = await db.query<{ id: string; version: number }>(
      `SELECT id, version FROM clarification_sessions WHERE project_id = ?`,
      ['proj-test-001'],
    );
    const session = sessionRows[0]!;

    const { runId: startRunId } = await runner.run(
      'start-clarification',
      {
        ...BASE_PAYLOAD,
        ...ACTOR,
        clarificationSessionId: session.id,
        expectedVersion: session.version,
      },
      runStartClarification,
    );
    const startRow = await getRunByTriggerdevId(db, startRunId);
    expect(startRow?.triggerdev_task_id).toBe('start-clarification');
    expect(startRow?.triggerdev_status).toBe('succeeded');

    const questionRows = await db.query<{ id: string; version: number }>(
      `SELECT id, version FROM clarification_questions WHERE clarification_session_id = ?`,
      [session.id],
    );
    for (const question of questionRows) {
      await runner.run(
        'record-clarification-answer',
        {
          ...BASE_PAYLOAD,
          ...ACTOR,
          clarificationQuestionId: question.id,
          clarificationSessionId: session.id,
          answer: 'The scope is a single-user todo list.',
          expectedQuestionVersion: question.version,
        },
        runRecordClarificationAnswer,
      );
    }

    const updatedSessionRows = await db.query<{ version: number }>(
      `SELECT version FROM clarification_sessions WHERE id = ?`,
      [session.id],
    );
    const { runId: completeRunId } = await runner.run(
      'complete-clarification',
      {
        ...BASE_PAYLOAD,
        ...ACTOR,
        clarificationSessionId: session.id,
        expectedVersion: updatedSessionRows[0]!.version,
        readinessResult: 'sufficient' as const,
      },
      runCompleteClarification,
    );
    const completeRow = await getRunByTriggerdevId(db, completeRunId);
    expect(completeRow?.triggerdev_task_id).toBe('complete-clarification');
    expect(completeRow?.triggerdev_status).toBe('succeeded');
  });

  it('generate-implementation-plan, generate-feature-backlog, validate-backlog, request-plan-approval, activate-approved-backlog', async () => {
    await runPlanningReadiness(
      {
        ...BASE_PAYLOAD,
        specificationContent: 'Build a todo app.',
        plannerAdapterName: 'MockPlannerAdapter',
      },
      db,
      fakePlanner('sufficient'),
    );
    const assessmentRows = await db.query<{ id: string }>(
      `SELECT id FROM planning_readiness_assessments WHERE project_id = ?`,
      ['proj-test-001'],
    );
    const assessmentId = assessmentRows[0]!.id;

    const { runId: planRunId } = await runner.run(
      'generate-implementation-plan',
      {
        ...BASE_PAYLOAD,
        assessmentId,
        title: 'Todo App Plan',
        sections: [{ title: 'Overview', content: 'Build CRUD endpoints.' }],
      },
      runGeneratePlan,
    );
    const planRow = await getRunByTriggerdevId(db, planRunId);
    expect(planRow?.triggerdev_task_id).toBe('generate-implementation-plan');
    expect(planRow?.triggerdev_status).toBe('succeeded');

    const planRows = await db.query<{ id: string; version: number }>(
      `SELECT id, version FROM implementation_plans WHERE project_id = ?`,
      ['proj-test-001'],
    );
    const plan = planRows[0]!;

    const { runId: backlogRunId } = await runner.run(
      'generate-feature-backlog',
      {
        ...BASE_PAYLOAD,
        planId: plan.id,
        features: [
          {
            frId: 'FR-001',
            title: 'Create todo',
            description: 'Allow creating a todo item.',
            kind: 'feature' as const,
            priority: 0,
            dependsOnFrIds: [],
            acceptanceCriteria: ['A user can create a todo.'],
            testExpectations: [
              { description: 'Creating a todo persists it.', testType: 'unit' as const },
            ],
          },
        ],
      },
      runGenerateBacklog,
    );
    const backlogRow = await getRunByTriggerdevId(db, backlogRunId);
    expect(backlogRow?.triggerdev_task_id).toBe('generate-feature-backlog');
    expect(backlogRow?.triggerdev_status).toBe('succeeded');

    const { runId: validateRunId } = await runner.run(
      'validate-backlog',
      { ...BASE_PAYLOAD, planId: plan.id },
      runValidateBacklog,
    );
    const validateRow = await getRunByTriggerdevId(db, validateRunId);
    expect(validateRow?.triggerdev_task_id).toBe('validate-backlog');
    expect(validateRow?.triggerdev_status).toBe('succeeded');

    const { runId: approvalRunId } = await runner.run(
      'request-plan-approval',
      { ...BASE_PAYLOAD, ...ACTOR, planId: plan.id, expectedVersion: plan.version },
      runRequestPlanApproval,
    );
    const approvalRow = await getRunByTriggerdevId(db, approvalRunId);
    expect(approvalRow?.triggerdev_task_id).toBe('request-plan-approval');
    expect(approvalRow?.triggerdev_status).toBe('succeeded');

    await db.execute(
      `UPDATE implementation_plans SET state = 'approved', version = version + 1 WHERE id = ?`,
      [plan.id],
    );
    const approvedPlanRows = await db.query<{ version: number }>(
      `SELECT version FROM implementation_plans WHERE id = ?`,
      [plan.id],
    );

    const { runId: activateRunId } = await runner.run(
      'activate-approved-backlog',
      {
        ...BASE_PAYLOAD,
        ...APPROVER,
        planId: plan.id,
        expectedVersion: approvedPlanRows[0]!.version,
      },
      runActivateBacklog,
    );
    const activateRow = await getRunByTriggerdevId(db, activateRunId);
    expect(activateRow?.triggerdev_task_id).toBe('activate-approved-backlog');
    expect(activateRow?.triggerdev_status).toBe('succeeded');
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

  it('export-plan, export-backlog, import-backlog', async () => {
    await runPlanningReadiness(
      {
        ...BASE_PAYLOAD,
        specificationContent: 'Build a todo app.',
        plannerAdapterName: 'MockPlannerAdapter',
      },
      db,
      fakePlanner('sufficient'),
    );
    const assessmentRows = await db.query<{ id: string }>(
      `SELECT id FROM planning_readiness_assessments WHERE project_id = ?`,
      ['proj-test-001'],
    );
    await runGeneratePlan(
      {
        ...BASE_PAYLOAD,
        assessmentId: assessmentRows[0]!.id,
        title: 'Todo App Plan',
        sections: [{ title: 'Overview', content: 'Build CRUD endpoints.' }],
      },
      db,
    );
    const planRows = await db.query<{ id: string }>(
      `SELECT id FROM implementation_plans WHERE project_id = ?`,
      ['proj-test-001'],
    );
    const planId = planRows[0]!.id;

    const { runId: exportPlanRunId } = await runner.run(
      'export-plan',
      { ...BASE_PAYLOAD, ...ACTOR, planId },
      runExportPlan,
    );
    const exportPlanRow = await getRunByTriggerdevId(db, exportPlanRunId);
    expect(exportPlanRow?.triggerdev_task_id).toBe('export-plan');
    expect(exportPlanRow?.triggerdev_status).toBe('succeeded');

    await runGenerateBacklog(
      {
        ...BASE_PAYLOAD,
        planId,
        features: [
          {
            frId: 'FR-001',
            title: 'Create todo',
            description: 'Allow creating a todo item.',
            kind: 'feature' as const,
            priority: 0,
            dependsOnFrIds: [],
            acceptanceCriteria: [],
            testExpectations: [],
          },
        ],
      },
      db,
    );

    const { runId: exportBacklogRunId } = await runner.run(
      'export-backlog',
      { ...BASE_PAYLOAD, ...ACTOR, planId },
      runExportBacklog,
    );
    const exportBacklogRow = await getRunByTriggerdevId(db, exportBacklogRunId);
    expect(exportBacklogRow?.triggerdev_task_id).toBe('export-backlog');
    expect(exportBacklogRow?.triggerdev_status).toBe('succeeded');

    const { runId: importRunId } = await runner.run(
      'import-backlog',
      {
        ...BASE_PAYLOAD,
        ...APPROVER,
        planId,
        features: [
          {
            frId: 'FR-002',
            title: 'Delete todo',
            description: 'Allow deleting a todo item.',
            kind: 'feature' as const,
            priority: 0,
            dependsOnFrIds: [],
          },
        ],
        dryRun: false,
      },
      runImportBacklog,
    );
    const importRow = await getRunByTriggerdevId(db, importRunId);
    expect(importRow?.triggerdev_task_id).toBe('import-backlog');
    expect(importRow?.triggerdev_status).toBe('succeeded');
  });
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

// ── assertSchemaReady ────────────────────────────────────────────────────────

describe('assertSchemaReady', () => {
  it('resolves when triggerdev_runs table exists (migrated DB)', async () => {
    const db = createTestDb();
    await expect(assertSchemaReady(db)).resolves.toBeUndefined();
    // no close — GC handles teardown (explicit close causes SIGSEGV via double-free of Statement finalizers)
  });

  it('throws with a clear message on an unmigrated DB', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { SqliteDbClient } = await import('@minicoder/persistence-sqlite');
    const raw = new Database(':memory:');
    const db = new SqliteDbClient(raw);
    await expect(assertSchemaReady(db)).rejects.toThrow('triggerdev_runs table not found');
    // no close — GC handles teardown (explicit close causes SIGSEGV via double-free of Statement finalizers)
  });
});
