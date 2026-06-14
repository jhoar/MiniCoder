import type { PlanningReadinessPayload } from './types.js';

export type { PlanningReadinessPayload };

export interface PlanningReadinessResult {
  projectId: string;
  readinessResult: 'sufficient' | 'sufficient_with_assumptions' | 'insufficient';
}

/**
 * Pure business logic — DB lifecycle tracking (linkRunToDb / updateRunStatus) is
 * handled by the calling layer (Trigger.dev task wrapper or MockTriggerRunner).
 * Orchestrator Core command invocation wired in Phase 6.
 */
export async function runImpl(payload: PlanningReadinessPayload): Promise<PlanningReadinessResult> {
  return {
    projectId: payload.projectId,
    readinessResult: 'sufficient',
  };
}
