import type { GithubReconciliationPayload } from './types.js';

export type { GithubReconciliationPayload };

export interface GithubReconciliationResult {
  projectId: string;
  reconciled: number;
  humanRequired: number;
}

/** Orchestrator Core reconciliation command wired in Phase 7. */
export async function runImpl(
  payload: GithubReconciliationPayload,
): Promise<GithubReconciliationResult> {
  return {
    projectId: payload.projectId,
    reconciled: 0,
    humanRequired: 0,
  };
}
