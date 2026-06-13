import type { ExportPlanPayload } from './types.js';

export type { ExportPlanPayload };

export interface ExportPlanResult {
  projectId: string;
  planId: string;
  artifactExportId: string;
}

/** Artifact export command wired in Phase 6. */
export async function runImpl(payload: ExportPlanPayload): Promise<ExportPlanResult> {
  return {
    projectId: payload.projectId,
    planId: payload.planId,
    artifactExportId: `ae-stub-${payload.planId}`,
  };
}
