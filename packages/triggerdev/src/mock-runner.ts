import type { DbClient } from '@minicoder/core';
import { linkRunToDb, updateRunStatus } from './metadata.js';

export type TaskRunFn<P, R> = (payload: P) => Promise<R>;

export interface MockRunResult<R> {
  runId: string;
  taskId: string;
  result: R;
  triggerdevRowId: string;
}

/**
 * MockTriggerRunner is the canonical test seam for unit and integration tests.
 * It executes a task's run implementation directly against a test DbClient,
 * bypassing the real Trigger.dev runtime but exercising the full DB linkage path.
 *
 * DB lifecycle (linkRunToDb / updateRunStatus) is handled here, mirroring what
 * the Trigger.dev task wrappers in triggerdev-tasks.ts do in production.
 */
export class MockTriggerRunner {
  private runCounter = 0;

  constructor(
    private readonly db: DbClient,
    private readonly defaultProjectId?: string,
  ) {}

  async run<P extends { projectId?: string }, R>(
    taskId: string,
    payload: P,
    impl: TaskRunFn<P, R>,
    runId?: string,
  ): Promise<MockRunResult<R>> {
    this.runCounter += 1;
    const resolvedRunId = runId ?? `mock-run-${taskId}-${this.runCounter}-${Date.now()}`;

    const rowId = await linkRunToDb(this.db, {
      triggerdevRunId: resolvedRunId,
      triggerdevTaskId: taskId,
      triggerdevStatus: 'running',
      projectId: payload.projectId ?? this.defaultProjectId,
    });

    let result: R;
    try {
      result = await impl(payload);
      await updateRunStatus(this.db, resolvedRunId, 'succeeded');
    } catch (err) {
      await updateRunStatus(this.db, resolvedRunId, 'failed');
      throw err;
    }

    return { runId: resolvedRunId, taskId, result, triggerdevRowId: rowId };
  }
}
