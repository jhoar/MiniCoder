import { describe, it, expect, beforeEach } from 'vitest';
import type { DbClient, ConfigBackend, SecretBackend, PlannerAgentAdapter } from '@minicoder/core';
import { MissingSecretError } from '@minicoder/core';
import { createTestDb, insertTestProject } from './test-helpers.js';
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
  it('exports the 15 canonical task ID strings', () => {
    expect(ALL_TASK_IDS).toHaveLength(15);
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
    expect(ALL_TASK_IDS).toContain('github-reconciliation');
    expect(ALL_TASK_IDS).toContain('export-plan');
    expect(ALL_TASK_IDS).toContain('export-backlog');
    expect(ALL_TASK_IDS).toContain('import-backlog');
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

  it('start-next-feature returns started boolean', async () => {
    const result = await runStartNextFeature(BASE_PAYLOAD, db);
    expect(typeof result.started).toBe('boolean');
  });

  it('github-reconciliation returns numeric reconciled and humanRequired counts', async () => {
    const result = await runGithubReconciliation(BASE_PAYLOAD, db);
    expect(typeof result.reconciled).toBe('number');
    expect(typeof result.humanRequired).toBe('number');
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
