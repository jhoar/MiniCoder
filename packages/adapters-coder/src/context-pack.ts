import { z } from 'zod';

/**
 * Versioned, structured input to a coder run (docs/03 §11.4 — "inputs (context pack) ... use
 * versioned Zod schemas"). Persisted verbatim (redacted) as one `agent_context_packs` row by
 * `AgentRunRecorder` — see CLAUDE.md's Reference Coder Adapter Operational Constraints.
 */
export const ContextPackV1Schema = z.object({
  schemaVersion: z.literal('1.0.0'),
  projectId: z.string(),
  featureRunId: z.string(),
  featureTitle: z.string(),
  acceptanceCriteria: z.array(z.string()),
  correlationId: z.string(),
});
export type ContextPackV1 = z.infer<typeof ContextPackV1Schema>;

export function buildContextPack(input: {
  projectId: string;
  featureRunId: string;
  featureTitle: string;
  acceptanceCriteria: string[];
  correlationId: string;
}): ContextPackV1 {
  return ContextPackV1Schema.parse({ schemaVersion: '1.0.0', ...input });
}
