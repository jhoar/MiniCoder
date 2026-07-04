/**
 * Merge Gate blocking-labels policy (Phase 12 — docs/01 §12).
 *
 * `pull_requests.blocking_labels` (Phase 7) mirrors *every* label GitHub reports on a PR — there
 * was deliberately no per-project "which labels actually block merge" policy defined at that
 * point (see the MEDIUM-2 code-review fix documented on `OctokitGitHubClient.getPullRequest()`).
 * This constant is that policy: a PR carrying any label in this set fails the merge gate. It is a
 * single, deployment-wide list (not yet per-project — a future per-project override is easy to add
 * on top of this default without changing the gate's shape) and is env-overridable via
 * `MERGE_GATE_BLOCKING_LABELS` (comma-separated, case-insensitive) so an operator can adjust it
 * without a code change.
 */
import { EnvConfigBackend } from '../config/config.js';

export const DEFAULT_MERGE_GATE_BLOCKING_LABELS = ['do-not-merge', 'wip', 'blocked'];

const envConfig = new EnvConfigBackend();

export function resolveBlockingLabelsPolicy(): string[] {
  const raw = envConfig.get('MERGE_GATE_BLOCKING_LABELS');
  if (raw === undefined) return DEFAULT_MERGE_GATE_BLOCKING_LABELS;
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed
    .split(',')
    .map((label) => label.trim().toLowerCase())
    .filter((label) => label.length > 0);
}
