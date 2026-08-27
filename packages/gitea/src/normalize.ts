/**
 * Normalizes raw Gitea webhook `(event, action)` pairs into MiniCoder's internal event-type
 * taxonomy — the exact same taxonomy `@minicoder/github`'s `normalize.ts` produces:
 *   pr.opened | pr.closed | pr.merged | pr.synchronized | check.passed | check.failed |
 *   review.approved | review.changes_requested | review.dismissed | review.commented |
 *   review.comment | push
 *
 * `branch.protection_ok` has no Gitea webhook equivalent (it is GitHub's own
 * `minicoder github simulate-*` dev-tooling-only event, not part of any real provider's webhook
 * taxonomy) and is intentionally not produced here.
 *
 * Returns `null` for event/action combinations MiniCoder does not act on — the webhook receiver
 * acknowledges these deliveries without writing an inbox_events row, mirroring
 * `@minicoder/github`'s identical behavior.
 *
 * Payload shapes below follow Gitea's documented webhook event payloads. Unlike
 * `@minicoder/github`'s normalizer (exercised against real GitHub deliveries since Phase 7), this
 * module has not yet been verified against a live Gitea instance in this repository's CI (see
 * `infra/docker-compose.gitea.yml`'s own header comment) — treat it as reviewed, reasonable
 * infrastructure needing a live-instance verification pass, the same posture CLAUDE.md already
 * documents for the Coder sandbox.
 */

export interface NormalizedGiteaEvent {
  eventType: string;
  /** owner/repo, used to resolve the internal projectId via the `repositories` table. */
  repoFullName: string;
  prNumber: number | null;
  payload: Record<string, unknown>;
}

interface RawWebhookPayload {
  action?: string;
  repository?: { full_name?: string };
  number?: number;
  pull_request?: {
    number?: number;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
    merged?: boolean;
    labels?: Array<{ name?: string }>;
    mergeable?: boolean | null;
  };
  review?: {
    type?: string;
    content?: string;
  };
  reviewer?: { login?: string };
  comment?: { id?: number };
  state?: string; // `status` event's commit-status state
  sha?: string;
  target_url?: string;
  ref?: string;
  after?: string;
  [key: string]: unknown;
}

/**
 * Gitea's pull_request_review `review.type` values (documented webhook payload shape) map onto
 * GitHub's `review.state` vocabulary as follows: `pull_request_review_approve` -> approved,
 * `pull_request_review_reject` -> changes requested (Gitea's "Request Changes" action),
 * `pull_request_review_comment` -> a plain review comment. There is no Gitea webhook type
 * corresponding to GitHub's `dismissed` review action.
 */
function mapGiteaReviewType(
  reviewType: string | undefined,
): 'approved' | 'changes_requested' | 'commented' | null {
  switch (reviewType) {
    case 'pull_request_review_approve':
      return 'approved';
    case 'pull_request_review_reject':
      return 'changes_requested';
    case 'pull_request_review_comment':
      return 'commented';
    default:
      return null;
  }
}

export function normalizeGiteaWebhookEvent(
  giteaEvent: string,
  raw: unknown,
): NormalizedGiteaEvent | null {
  const payload = raw as RawWebhookPayload;
  const repoFullName = payload.repository?.full_name ?? '';

  switch (giteaEvent) {
    case 'pull_request': {
      const prNumber = payload.pull_request?.number ?? payload.number ?? null;
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
      if (action === 'synchronized') {
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
      const prNumber = payload.pull_request?.number ?? payload.number ?? null;
      if (payload.action !== 'submitted') return null;
      const mapped = mapGiteaReviewType(payload.review?.type);
      if (mapped === null) return null;
      const eventType =
        mapped === 'approved'
          ? 'review.approved'
          : mapped === 'changes_requested'
            ? 'review.changes_requested'
            : 'review.commented';
      return {
        eventType,
        repoFullName,
        prNumber,
        payload: {
          prNumber,
          reviewer: payload.reviewer?.login ?? null,
          reviewType: payload.review?.type ?? null,
        },
      };
    }

    case 'pull_request_comment': {
      // Conversation-thread activity (an inline or issue-level comment on a PR) — surfaced for
      // reconciliation the same way `@minicoder/github`'s `review.comment` is, but does not itself
      // drive a feature-execution transition.
      const prNumber = payload.pull_request?.number ?? payload.number ?? null;
      return {
        eventType: 'review.comment',
        repoFullName,
        prNumber,
        payload: { prNumber, action: payload.action ?? null },
      };
    }

    case 'status': {
      // Gitea has no separate Checks-API concept (unlike GitHub) — commit statuses are the only CI
      // signal, so this single webhook event carries the entirety of Gitea's CI-outcome taxonomy.
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
      // 'pending'/'warning' (or any other reported state) carry no verdict yet — not normalized,
      // mirroring `@minicoder/github`'s identical treatment of a non-terminal commit-status state.
      return null;
    }

    case 'push': {
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
