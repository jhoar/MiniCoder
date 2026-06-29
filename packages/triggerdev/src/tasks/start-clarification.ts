import type { StartClarificationPayload } from './types.js';

export type { StartClarificationPayload };

export interface StartClarificationResult {
  projectId: string;
  clarificationSessionId: string;
}

/** Orchestrator Core command invocation wired in Phase 6. */
export async function runImpl(
  payload: StartClarificationPayload,
): Promise<StartClarificationResult> {
  return {
    projectId: payload.projectId,
    clarificationSessionId: `cs-stub-${payload.projectId}`,
  };
}
