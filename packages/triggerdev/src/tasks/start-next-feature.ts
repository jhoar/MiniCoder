import type { DbClient } from '@minicoder/core';
import type { StartNextFeaturePayload } from './types.js';

export type { StartNextFeaturePayload };

export interface StartNextFeatureResult {
  projectId: string;
  featureRunId: string | null;
  started: boolean;
}

/** Orchestrator Core command invocation wired in Phase 8. */
export async function runImpl(
  payload: StartNextFeaturePayload,
  _db?: DbClient,
): Promise<StartNextFeatureResult> {
  return {
    projectId: payload.projectId,
    featureRunId: payload.featureRunId ?? null,
    started: false,
  };
}
