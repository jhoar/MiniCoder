import {
  CommandError,
  FeatureExecutionState,
  SelectFeatureHandler,
  StartCodingHandler,
  TransactionalCommandExecutor,
  findNextEligibleFeatureRun,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import { ExecutionLane } from '@minicoder/workflow';
import type { StartNextFeaturePayload } from './types.js';
import { automationOperatorActor, systemActor } from './actor.js';

export type { StartNextFeaturePayload };

export interface StartNextFeatureResult {
  projectId: string;
  featureRunId: string | null;
  started: boolean;
}

const selectFeatureHandler = new SelectFeatureHandler();
const startCodingHandler = new StartCodingHandler();

const EXECUTION_LANE_TTL_MS = 30_000;

interface FeatureRunVersionRow {
  version: number;
}

// CommandErrors that represent an expected race for an opportunistically/scheduled-invoked
// task (another worker already selected a feature, automation is paused, or the candidate's
// dependencies changed underneath us) — these are reported as `started: false`, not thrown,
// mirroring how github-reconciliation.ts treats per-candidate failures as non-fatal.
const EXPECTED_ERROR_TYPES = new Set([
  'feature-already-active',
  'automation-paused',
  'unmet-dependencies',
  'not-found',
]);

function isExpectedRace(err: unknown): boolean {
  return err instanceof CommandError && EXPECTED_ERROR_TYPES.has(err.problem.type);
}

/**
 * Selects the next eligible feature (or the one named in payload.featureRunId) and starts
 * coding on it, in one task invocation: selected -> coding has no human/webhook gate between
 * them (unlike pr_opened -> ci_running, which is genuinely event-driven), so splitting this
 * across two Trigger.dev tasks would add a durable hand-off state with no benefit.
 */
export async function runImpl(
  payload: StartNextFeaturePayload,
  db: DbClient,
): Promise<StartNextFeatureResult> {
  const { projectId, correlationId } = payload;

  let featureRunId = payload.featureRunId ?? null;
  let skipSelection = false;

  if (!featureRunId) {
    // Recover a feature run stranded at 'selected' by a pause/budget-pause that landed between
    // SelectFeatureCommand succeeding and StartCodingCommand dispatching (HIGH-1 in a Phase 8
    // code review round). workflow_states.active_feature_run_id already points at it, so
    // SelectFeatureHandler's compare-and-swap would reject any other candidate anyway — without
    // this check, findNextEligibleFeatureRun (which only looks for approved_pending_execution
    // rows) would never surface it again, stranding the project until manual intervention.
    const activeRows = await db.query<{ active_feature_run_id: string | null }>(
      `SELECT active_feature_run_id FROM workflow_states WHERE project_id = ?`,
      [projectId],
    );
    const activeFeatureRunId = activeRows[0]?.active_feature_run_id ?? null;
    if (activeFeatureRunId) {
      const activeRunRows = await db.query<{ current_execution_state: string }>(
        `SELECT current_execution_state FROM feature_runs WHERE id = ?`,
        [activeFeatureRunId],
      );
      if (activeRunRows[0]?.current_execution_state === FeatureExecutionState.SELECTED) {
        featureRunId = activeFeatureRunId;
        skipSelection = true;
      }
    }
  }

  if (!featureRunId) {
    const candidate = await findNextEligibleFeatureRun(db, projectId);
    if (!candidate) {
      return { projectId, featureRunId: null, started: false };
    }
    featureRunId = candidate.id;
  }

  const wsRows = await db.query<{ automation_state: string }>(
    `SELECT automation_state FROM workflow_states WHERE project_id = ?`,
    [projectId],
  );
  if (wsRows[0]?.automation_state !== 'running') {
    return { projectId, featureRunId, started: false };
  }

  const runRows = await db.query<FeatureRunVersionRow>(
    `SELECT version FROM feature_runs WHERE id = ?`,
    [featureRunId],
  );
  const currentVersion = runRows[0]?.version;
  if (currentVersion === undefined) {
    return { projectId, featureRunId, started: false };
  }

  // SelectFeatureCommand requires a human/operator actor per its matrix row; StartCodingCommand
  // requires a system actor — see automationOperatorActor's doc comment for why the former uses
  // a placeholder human identity rather than a weakened system actor.
  const selectActor = automationOperatorActor(correlationId);
  const codingActor = systemActor(correlationId);
  const executor = new TransactionalCommandExecutor(db);

  if (!skipSelection) {
    const selectPayload = { featureRunId, projectId, expectedVersion: currentVersion };
    const selectEnvelope: CommandEnvelope<typeof selectPayload> = {
      commandId: generateId(),
      idempotencyKey: `select-feature:${featureRunId}`,
      payload: selectPayload,
      actor: selectActor,
      correlationId,
    };
    try {
      await executor.execute(selectFeatureHandler, selectEnvelope);
    } catch (err) {
      if (isExpectedRace(err)) {
        return { projectId, featureRunId, started: false };
      }
      throw err;
    }
  }

  const lane = new ExecutionLane(db);
  const lock = await lane.acquireForProject(
    projectId,
    'start-next-feature-task',
    EXECUTION_LANE_TTL_MS,
  );
  try {
    const selectedRows = await db.query<FeatureRunVersionRow>(
      `SELECT version FROM feature_runs WHERE id = ?`,
      [featureRunId],
    );
    const selectedVersion = selectedRows[0]?.version ?? currentVersion + 1;

    const startCodingPayload = { featureRunId, projectId, expectedVersion: selectedVersion };
    const startCodingEnvelope: CommandEnvelope<typeof startCodingPayload> = {
      commandId: generateId(),
      idempotencyKey: `start-coding:${featureRunId}`,
      payload: startCodingPayload,
      actor: codingActor,
      correlationId,
      lockContext: {
        lockId: lock.lockId,
        fence: lock.fence,
        holderId: lock.holderId,
        projectId,
        resourceKey: lock.resourceKey,
      },
    };
    await executor.execute(startCodingHandler, startCodingEnvelope);
  } catch (err) {
    if (isExpectedRace(err)) {
      return { projectId, featureRunId, started: false };
    }
    throw err;
  } finally {
    await lane.releaseForProject(lock);
  }

  return { projectId, featureRunId, started: true };
}
