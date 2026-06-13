import type { ActivateApprovedBacklogPayload } from './types.js';

export type { ActivateApprovedBacklogPayload };

export interface ActivateApprovedBacklogResult {
  projectId: string;
  planId: string;
  activatedFeatureCount: number;
}

/** Orchestrator Core command invocation wired in Phase 6. */
export async function runImpl(
  payload: ActivateApprovedBacklogPayload,
): Promise<ActivateApprovedBacklogResult> {
  return {
    projectId: payload.projectId,
    planId: payload.planId,
    activatedFeatureCount: 0,
  };
}
