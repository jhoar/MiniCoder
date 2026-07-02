/**
 * Normalizes raw GitHub webhook `(event, action)` pairs into MiniCoder's internal event-type
 * taxonomy — the same taxonomy already established by `minicoder github simulate-*`
 * (packages/cli/src/commands/github.ts) and `MockGitHubProvider`
 * (packages/testing/src/services/mock-github-provider.ts):
 *   pr.opened | pr.closed | pr.merged | pr.synchronized | check.passed | check.failed |
 *   review.approved | review.changes_requested | review.dismissed | branch.protection_ok | push
 *
 * Returns `null` for event/action combinations MiniCoder does not act on (e.g. a
 * pull_request `labeled` action) — the webhook receiver acknowledges these deliveries without
 * writing an inbox_events row.
 */

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
  check_run?: { id?: number; conclusion?: string | null; status?: string; pull_requests?: Array<{ number?: number }> };
  check_suite?: { conclusion?: string | null; pull_requests?: Array<{ number?: number }> };
  state?: string; // legacy commit `status` event
  sha?: string;
  ref?: string;
  [key: string]: unknown;
}

const PASSING_CONCLUSIONS = new Set(['success']);
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

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
      if (conclusion && PASSING_CONCLUSIONS.has(conclusion)) {
        return {
          eventType: 'check.passed',
          repoFullName,
          prNumber,
          payload: { prNumber, checkRunId: payload.check_run?.id ?? null, conclusion },
        };
      }
      if (conclusion && FAILING_CONCLUSIONS.has(conclusion)) {
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
      if (conclusion && PASSING_CONCLUSIONS.has(conclusion)) {
        return { eventType: 'check.passed', repoFullName, prNumber, payload: { prNumber, conclusion } };
      }
      if (conclusion && FAILING_CONCLUSIONS.has(conclusion)) {
        return { eventType: 'check.failed', repoFullName, prNumber, payload: { prNumber, conclusion } };
      }
      return null;
    }

    case 'status': {
      const state = payload.state;
      if (state === 'success') {
        return { eventType: 'check.passed', repoFullName, prNumber: null, payload: { sha: payload.sha, state } };
      }
      if (state === 'failure' || state === 'error') {
        return { eventType: 'check.failed', repoFullName, prNumber: null, payload: { sha: payload.sha, state } };
      }
      return null;
    }

    case 'push': {
      return {
        eventType: 'push',
        repoFullName,
        prNumber: null,
        payload: { ref: payload.ref ?? null, sha: payload.sha ?? null },
      };
    }

    default:
      return null;
  }
}
