import { z } from 'zod';

/** Capability tokens from docs/03-agent-adapter-architecture.md §3. */
export const AgentCapabilitySchema = z.enum([
  'can_generate_plan',
  'can_generate_clarification_questions',
  'can_modify_files',
  'can_run_tests',
  'can_commit',
  'can_push_branch',
  'can_open_pull_request',
  'can_review_pull_request',
  'can_return_structured_findings',
  'can_resolve_disagreement',
  'can_generate_design_document',
  'can_report_token_usage',
  'can_report_cost',
  'can_run_asynchronously',
  'can_report_run_status',
]);

export type AgentCapabilityToken = z.infer<typeof AgentCapabilitySchema>;

export class CapabilityError extends Error {
  constructor(
    public readonly adapterId: string,
    public readonly missing: readonly AgentCapabilityToken[],
  ) {
    super(`Adapter ${adapterId} is missing required capabilities: ${missing.join(', ')}`);
    this.name = 'CapabilityError';
  }
}

/**
 * Throws CapabilityError if any capability in `required` is absent from `declared`.
 * Called before every adapter invocation (03 §3: "the orchestrator validates capabilities
 * before invocation").
 */
export function validateCapabilities(
  adapterId: string,
  declared: readonly AgentCapabilityToken[],
  required: readonly AgentCapabilityToken[],
): void {
  const declaredSet = new Set(declared);
  const missing = required.filter((capability) => !declaredSet.has(capability));
  if (missing.length > 0) {
    throw new CapabilityError(adapterId, missing);
  }
}
