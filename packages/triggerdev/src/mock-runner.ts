import type { DbClient } from '@minicoder/core';
import { linkRunToDb, updateRunStatus } from './metadata.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TaskRunFn<P, R> = (payload: P, db: DbClient, extra?: any) => Promise<R>;

export interface MockRunResult<R> {
  runId: string;
  taskId: string;
  result: R;
  triggerdevRowId: string;
}

/**
 * MockTriggerRunner is the canonical test seam for unit and integration tests.
 * It executes a task's run implementation directly against a test DbClient,
 * bypassing the real task-queue worker but exercising the full DB linkage path.
 *
 * DB lifecycle (linkRunToDb / updateRunStatus) is handled here, mirroring what
 * task-registry.ts's runRegisteredTask() does in production.
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
    // NoInfer forces P to be inferred solely from `payload`, not from `impl` — callers passing a
    // loosely-typed inline closure (e.g. `async (_payload: unknown) => ...`) must not widen P.
    impl: TaskRunFn<NoInfer<P>, R>,
    runId?: string,
    extra?: unknown,
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
      result = await impl(payload, this.db, extra);
      await updateRunStatus(this.db, resolvedRunId, 'succeeded');
    } catch (err) {
      await updateRunStatus(this.db, resolvedRunId, 'failed');
      throw err;
    }

    return { runId: resolvedRunId, taskId, result, triggerdevRowId: rowId };
  }
}
