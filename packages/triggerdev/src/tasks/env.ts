/**
 * Shared env-var validation for Trigger.dev task entrypoints — extracted from `run-coder.ts` so
 * `github-reconciliation.ts` shares the same blank-rejection contract instead of drifting back to
 * a truthiness-only check (LOW-1 code-review fix, round 5; CLAUDE.md's Reference Coder Adapter
 * Operational Constraints). A whitespace-only value previously passed a bare `if (!value)` check
 * and failed later with a less actionable error (e.g. an Octokit auth failure instead of a clear
 * "not configured" message).
 */
export function requireNonBlankEnvVar(envVarName: string, helpText: string): string {
  const raw = process.env[envVarName];
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new Error(`${envVarName} is not configured. ${helpText}`);
  }
  return trimmed;
}
