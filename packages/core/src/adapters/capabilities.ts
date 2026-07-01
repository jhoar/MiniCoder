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

export class InvalidCapabilityError extends Error {
  constructor(
    public readonly source: string,
    public readonly invalid: readonly unknown[],
  ) {
    super(
      `${source} contains invalid capability token(s): ${invalid.map((v) => JSON.stringify(v)).join(', ')}`,
    );
    this.name = 'InvalidCapabilityError';
  }
}

/** Position of each token in AgentCapabilitySchema — the canonical ordering used by parseCapabilities. */
const CANONICAL_ORDER: ReadonlyMap<AgentCapabilityToken, number> = new Map(
  AgentCapabilitySchema.options.map((token, index) => [token, index]),
);

/**
 * Validates every entry against AgentCapabilitySchema, dedupes, and sorts by canonical schema
 * order (the token's position in AgentCapabilitySchema). Throws InvalidCapabilityError (not a
 * raw ZodError) with every offending value listed, so both caller-supplied registration input
 * and rows read back from the database fail loudly rather than silently casting an
 * unrecognized string to AgentCapabilityToken (docs/03 §3).
 *
 * Sorting canonically — rather than relying on physical row order or an ORDER BY on
 * created_at/id — makes the returned capability array deterministic across storage engines and
 * independent of insertion timing, since multiple capability rows inserted in the same
 * registration call share an identical `created_at` timestamp.
 */
export function parseCapabilities(
  capabilities: readonly unknown[],
  source: string,
): AgentCapabilityToken[] {
  const invalid: unknown[] = [];
  const seen = new Set<AgentCapabilityToken>();
  for (const value of capabilities) {
    const parsed = AgentCapabilitySchema.safeParse(value);
    if (!parsed.success) {
      invalid.push(value);
      continue;
    }
    seen.add(parsed.data);
  }
  if (invalid.length > 0) {
    throw new InvalidCapabilityError(source, invalid);
  }
  return Array.from(seen).sort((a, b) => CANONICAL_ORDER.get(a)! - CANONICAL_ORDER.get(b)!);
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
