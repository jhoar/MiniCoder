import type { ScmClient } from '../scm/client.js';
import type { MergeGateDecision } from './evaluate-merge-gate.js';

/**
 * Publishes the `minicoder/review-gate` status check (docs/00 §3.11, docs/01 §5.7/§12) reflecting
 * a Merge Gate evaluation's outcome onto the PR's current head commit. Callers
 * (`run-merge-gate.ts`, `minicoder merge merge-if-ready`) already hold a `ScmClient` and the
 * evaluated PR's `owner`/`repo`/`sha` — this is a thin, side-effect-only wrapper so both call
 * sites publish with identical `context`/state semantics instead of drifting apart.
 */
export async function publishMergeGateStatusCheck(
  githubClient: ScmClient,
  opts: {
    owner: string;
    repo: string;
    sha: string;
    decision: MergeGateDecision;
    reasons: string[];
  },
): Promise<void> {
  await githubClient.publishStatusCheck({
    owner: opts.owner,
    repo: opts.repo,
    sha: opts.sha,
    context: 'minicoder/review-gate',
    state: opts.decision === 'approved' ? 'success' : 'failure',
    description:
      opts.decision === 'approved'
        ? 'Merge gate passed'
        : `Merge gate rejected: ${opts.reasons.join('; ')}`.slice(0, 140),
  });
}
