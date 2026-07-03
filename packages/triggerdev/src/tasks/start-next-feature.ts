import {
  CommandError,
  FeatureExecutionState,
  OptimisticLockError,
  SelectFeatureHandler,
  StaleFenceError,
  StartCodingHandler,
  TransactionalCommandExecutor,
  findNextEligibleFeatureRun,
  generateId,
} from '@minicoder/core';
import type { CommandEnvelope, DbClient } from '@minicoder/core';
import { ExecutionLane, LockConflictError } from '@minicoder/workflow';
import type { AcquiredLock } from '@minicoder/workflow';
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

// CommandError `problem.type`s that represent an expected race for an opportunistically/
// scheduled-invoked task: another worker already selected a feature, automation was paused/
// budget-paused in the meantime, the candidate's dependencies changed underneath us, the row
// vanished, or two invocations raced on the same idempotency key in-flight.
const EXPECTED_COMMAND_ERROR_TYPES = new Set([
  'feature-already-active',
  'automation-paused',
  'unmet-dependencies',
  'not-found',
  'concurrent-command',
]);

/**
 * A transient concurrency loss that a later invocation will simply retry past — reported as
 * `started: false`, not thrown, mirroring how github-reconciliation.ts treats per-candidate
 * failures as non-fatal. This task is scheduled/opportunistic and idempotent, so any "another
 * actor moved state under us" condition should defer to the next tick rather than surface a
 * spurious Trigger.dev task failure:
 *   - LockConflictError: another holder (a concurrent start-next-feature retry, a
 *     github-reconciliation pass acquiring the same `execution-lane:{projectId}` lock, or an
 *     HA-cluster peer) owns the project's execution lane;
 *   - OptimisticLockError: a concurrent writer bumped feature_runs.version between this task's
 *     fresh read and the command's compare-and-swap (the version is always read immediately
 *     before each dispatch, so a mismatch here is a race, not a stale-version bug);
 *   - StaleFenceError: the execution-lane lease was reclaimed mid-operation;
 *   - an expected CommandError type (see the set above).
 * A genuine infrastructure failure (DB down, etc.) is none of these and still throws, correctly
 * triggering Trigger.dev's retry/failed-status handling.
 */
function isTransientRace(err: unknown): boolean {
  if (err instanceof LockConflictError) return true;
  if (err instanceof OptimisticLockError) return true;
  if (err instanceof StaleFenceError) return true;
  return err instanceof CommandError && EXPECTED_COMMAND_ERROR_TYPES.has(err.problem.type);
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

  // The idempotency keys here are scoped to featureRunId, not {featureRunId}:{expectedVersion},
  // and that is correct: a feature_runs row is a single execution attempt that transitions
  // ->selected and ->coding at most once in its lifetime, so the run id is already an
  // occurrence-unique discriminator (unlike the recurring project-scoped pause/resume/budget
  // keys). A failed attempt rolls back its idempotency claim inside the handler's transaction, so
  // a retry re-executes rather than replaying a stale result.
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
      if (isTransientRace(err)) {
        return { projectId, featureRunId, started: false };
      }
      throw err;
    }
  }

  // The execution lane is contended (concurrent start-next-feature retries, github-reconciliation
  // passes on the same `execution-lane:{projectId}` lock, HA-cluster peers) — a lost acquire is
  // an expected race, not a failure. Acquire in its own try so a LockConflictError returns
  // `started: false` (the feature run stays at `selected`; the next tick recovers it via the
  // stranded-selected path above) without entering the release-in-finally block below.
  const lane = new ExecutionLane(db);
  let lock: AcquiredLock;
  try {
    lock = await lane.acquireForProject(
      projectId,
      'start-next-feature-task',
      EXECUTION_LANE_TTL_MS,
    );
  } catch (err) {
    if (isTransientRace(err)) {
      return { projectId, featureRunId, started: false };
    }
    throw err;
  }

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
    if (isTransientRace(err)) {
      return { projectId, featureRunId, started: false };
    }
    throw err;
  } finally {
    await lane.releaseForProject(lock);
  }

  return { projectId, featureRunId, started: true };
}
