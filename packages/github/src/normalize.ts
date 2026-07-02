/**
 * Normalizes raw GitHub webhook `(event, action)` pairs into MiniCoder's internal event-type
 * taxonomy — the same taxonomy already established by `minicoder github simulate-*`
 * (packages/cli/src/commands/github.ts) and `MockGitHubProvider`
 * (packages/testing/src/services/mock-github-provider.ts):
 *   pr.opened | pr.closed | pr.merged | pr.synchronized | check.passed | check.failed |
 *   review.approved | review.changes_requested | review.dismissed | review.commented |
 *   review.comment | branch.protection_ok | push
 *
 * Returns `null` for event/action combinations MiniCoder does not act on (e.g. a
 * pull_request `labeled` action) — the webhook receiver acknowledges these deliveries without
 * writing an inbox_events row.
 */

import { classifyCheckConclusion } from './check-conclusion.js';

export interface NormalizedGithubEvent {
  eventType: string;
  /** owner/repo, used to resolve the internal projectId via the `repositories` table. */
  repoFullName: string;
  prNumber: number | null;
  payload: Record<string, unknown>;
}

interface RawWebhookPayload {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: {
    number?: number;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
    merged?: boolean;
    labels?: Array<{ name?: string }>;
    mergeable?: boolean | null;
  };
  review?: { state?: string; user?: { login?: string } };
  check_run?: {
    id?: number;
    conclusion?: string | null;
    status?: string;
    pull_requests?: Array<{ number?: number }>;
  };
  check_suite?: { conclusion?: string | null; pull_requests?: Array<{ number?: number }> };
  state?: string; // legacy commit `status` event
  sha?: string;
  ref?: string;
  /** New commit SHA on a `push` webhook — GitHub carries it here, not under `sha`. */
  after?: string;
  [key: string]: unknown;
}

export function normalizeGithubWebhookEvent(
  githubEvent: string,
  raw: unknown,
): NormalizedGithubEvent | null {
  const payload = raw as RawWebhookPayload;
  const repoFullName = payload.repository?.full_name ?? '';

  switch (githubEvent) {
    case 'pull_request': {
      const prNumber = payload.pull_request?.number ?? null;
      const action = payload.action;
      if (action === 'opened' || action === 'reopened') {
        return {
          eventType: 'pr.opened',
          repoFullName,
          prNumber,
          payload: {
            prNumber,
            branchName: payload.pull_request?.head?.ref ?? null,
            baseBranch: payload.pull_request?.base?.ref ?? null,
            headSha: payload.pull_request?.head?.sha ?? null,
            action,
          },
        };
      }
      if (action === 'synchronize') {
        return {
          eventType: 'pr.synchronized',
          repoFullName,
          prNumber,
          payload: { prNumber, headSha: payload.pull_request?.head?.sha ?? null, action },
        };
      }
      if (action === 'closed') {
        const merged = payload.pull_request?.merged === true;
        return {
          eventType: merged ? 'pr.merged' : 'pr.closed',
          repoFullName,
          prNumber,
          payload: { prNumber, action, merged },
        };
      }
      return null;
    }

    case 'pull_request_review': {
      const prNumber = payload.pull_request?.number ?? null;
      const action = payload.action;
      const state = payload.review?.state;
      if (action === 'dismissed') {
        return {
          eventType: 'review.dismissed',
          repoFullName,
          prNumber,
          payload: { prNumber, reviewer: payload.review?.user?.login ?? null },
        };
      }
      if (action === 'submitted' && state === 'approved') {
        return {
          eventType: 'review.approved',
          repoFullName,
          prNumber,
          payload: { prNumber, reviewer: payload.review?.user?.login ?? null, state },
        };
      }
      if (action === 'submitted' && state === 'changes_requested') {
        return {
          eventType: 'review.changes_requested',
          repoFullName,
          prNumber,
          payload: { prNumber, reviewer: payload.review?.user?.login ?? null, state },
        };
      }
      // HIGH-4 code-review fix (round 5): a `submitted` review with `state: 'commented'` (a
      // review-level comment, not `pull_request_review_comment`'s inline-code comment — a
      // different GitHub event entirely, handled separately below as `review.comment`) had no
      // branch here and was silently dropped. `review.commented` triggers a reconciliation pass
      // like any other review event; `octokit-client.ts`'s `deriveReviewState` re-derives the PR's
      // authoritative aggregate sticky-blocking review state from the full review list, so no
      // bespoke handling of the "commented" verdict itself is needed here.
      if (action === 'submitted' && state === 'commented') {
        return {
          eventType: 'review.commented',
          repoFullName,
          prNumber,
          payload: { prNumber, reviewer: payload.review?.user?.login ?? null, state },
        };
      }
      return null;
    }

    case 'pull_request_review_comment': {
      // Conversation-thread activity — surfaced for conversations_resolved tracking but does not
      // itself drive a feature-execution transition.
      const prNumber = payload.pull_request?.number ?? null;
      return {
        eventType: 'review.comment',
        repoFullName,
        prNumber,
        payload: { prNumber, action: payload.action ?? null },
      };
    }

    case 'check_run': {
      if (payload.action !== 'completed') return null;
      const prNumber = payload.check_run?.pull_requests?.[0]?.number ?? null;
      const conclusion = payload.check_run?.conclusion ?? null;
      // HIGH-4 / MEDIUM-1 code-review fix (round 5): classification now delegates to the shared
      // `classifyCheckConclusion()` (`./check-conclusion.ts`), the same helper `octokit-client.ts`'s
      // `deriveCiStatus` uses. Previously this case used its own `PASSING_CONCLUSIONS`/
      // `FAILING_CONCLUSIONS` sets that were never updated to match round-4's `deriveCiStatus` fix,
      // so a `neutral`/`skipped`/`stale`/`startup_failure` conclusion fell through to `return null`
      // and was silently dropped instead of normalizing to `check.passed`/`check.failed`.
      const classification = classifyCheckConclusion(conclusion);
      if (classification === 'passed') {
        return {
          eventType: 'check.passed',
          repoFullName,
          prNumber,
          payload: { prNumber, checkRunId: payload.check_run?.id ?? null, conclusion },
        };
      }
      if (classification === 'failed') {
        return {
          eventType: 'check.failed',
          repoFullName,
          prNumber,
          payload: { prNumber, checkRunId: payload.check_run?.id ?? null, conclusion },
        };
      }
      return null;
    }

    case 'check_suite': {
      if (payload.action !== 'completed') return null;
      const prNumber = payload.check_suite?.pull_requests?.[0]?.number ?? null;
      const conclusion = payload.check_suite?.conclusion ?? null;
      // See the `check_run` case above — same shared-classifier fix.
      const classification = classifyCheckConclusion(conclusion);
      if (classification === 'passed') {
        return {
          eventType: 'check.passed',
          repoFullName,
          prNumber,
          payload: { prNumber, conclusion },
        };
      }
      if (classification === 'failed') {
        return {
          eventType: 'check.failed',
          repoFullName,
          prNumber,
          payload: { prNumber, conclusion },
        };
      }
      return null;
    }

    case 'status': {
      const state = payload.state;
      if (state === 'success') {
        return {
          eventType: 'check.passed',
          repoFullName,
          prNumber: null,
          payload: { sha: payload.sha, state },
        };
      }
      if (state === 'failure' || state === 'error') {
        return {
          eventType: 'check.failed',
          repoFullName,
          prNumber: null,
          payload: { sha: payload.sha, state },
        };
      }
      return null;
    }

    case 'push': {
      // HIGH-5 code-review fix: a real GitHub push webhook has no `sha` field at all — the new
      // commit is carried under `after` — and `resolveFeatureRunId` (packages/github/src/
      // inbox-handlers.ts) has no branch that reads a raw `ref` field, only the already-stripped
      // `branchName` its step-3 lookup expects (mirroring the format `pr.opened`'s `branchName`
      // already uses). Strip the `refs/heads/` prefix here so the normalized payload resolves to
      // a tracked feature run instead of silently going unmatched.
      const ref = payload.ref ?? null;
      const branchName = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      return {
        eventType: 'push',
        repoFullName,
        prNumber: null,
        payload: { branchName, sha: payload.after ?? null },
      };
    }

    default:
      return null;
  }
}
