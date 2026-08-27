/**
 * Normalizes raw GitLab webhook events into MiniCoder's internal event-type taxonomy — the exact
 * same taxonomy `@minicoder/github`'s and `@minicoder/gitea`'s `normalize.ts` produce:
 *   pr.opened | pr.closed | pr.merged | pr.synchronized | check.passed | check.failed |
 *   review.approved | review.comment | push
 *
 * **`review.changes_requested` is never produced here — a real, documented gap, not an
 * oversight.** GitLab has no webhook event corresponding to a discrete "reviewer requested
 * changes" action the way GitHub's `pull_request_review` (`state: 'changes_requested'`) or Gitea's
 * `pull_request_review_reject` type does. The closest GitLab signal — an unresolved discussion
 * thread plus insufficient approvals — is only knowable by fetching current MR state
 * (`GitlabScmClient.getPullRequest()`'s `deriveReviewState()` synthesis), which webhook payloads do
 * not carry. This means the scheduled reconciliation fallback (not a webhook) is the primary,
 * load-bearing path for catching this condition on a GitLab-backed project — see docs/06 §Phase 18
 * Stage 4 and this package's own regression test proving that fallback path.
 *
 * `review.dismissed` and `branch.protection_ok` have no GitLab equivalent either, for the same
 * reason as Gitea (see `@minicoder/gitea`'s identical note).
 *
 * Payload shapes below follow GitLab's documented webhook event payloads (Merge Request Hook,
 * Pipeline Hook, Note Hook). Not yet verified against a live GitLab instance in this repository's
 * CI — see `infra/docker-compose.gitlab.yml`'s own header comment.
 */

export interface NormalizedGitlabEvent {
  eventType: string;
  /** owner/repo, used to resolve the internal projectId via the `repositories` table. */
  repoFullName: string;
  prNumber: number | null;
  payload: Record<string, unknown>;
}

interface MergeRequestHookPayload {
  object_kind?: 'merge_request';
  project?: { path_with_namespace?: string };
  object_attributes?: {
    iid?: number;
    action?: string;
    source_branch?: string;
    target_branch?: string;
    last_commit?: { id?: string };
    oldrev?: string;
    state?: string;
  };
  user?: { username?: string };
}

interface PipelineHookPayload {
  object_kind?: 'pipeline';
  project?: { path_with_namespace?: string };
  object_attributes?: { status?: string; sha?: string };
}

interface NoteHookPayload {
  object_kind?: 'note';
  project?: { path_with_namespace?: string };
  object_attributes?: { noteable_type?: string; action?: string };
  merge_request?: { iid?: number };
}

interface PushHookPayload {
  object_kind?: 'push';
  project?: { path_with_namespace?: string };
  ref?: string;
  after?: string;
}

export function normalizeGitlabWebhookEvent(
  objectKind: string,
  raw: unknown,
): NormalizedGitlabEvent | null {
  switch (objectKind) {
    case 'merge_request': {
      const payload = raw as MergeRequestHookPayload;
      const repoFullName = payload.project?.path_with_namespace ?? '';
      const prNumber = payload.object_attributes?.iid ?? null;
      const action = payload.object_attributes?.action;

      if (action === 'open' || action === 'reopen') {
        return {
          eventType: 'pr.opened',
          repoFullName,
          prNumber,
          payload: {
            prNumber,
            branchName: payload.object_attributes?.source_branch ?? null,
            baseBranch: payload.object_attributes?.target_branch ?? null,
            headSha: payload.object_attributes?.last_commit?.id ?? null,
            action,
          },
        };
      }
      if (action === 'update' && payload.object_attributes?.oldrev) {
        // A source-branch push — GitLab's "update" action also fires for title/label/description
        // edits, distinguished from a real push only by the presence of `oldrev` (the previous
        // HEAD commit before this update).
        return {
          eventType: 'pr.synchronized',
          repoFullName,
          prNumber,
          payload: {
            prNumber,
            headSha: payload.object_attributes?.last_commit?.id ?? null,
            action,
          },
        };
      }
      if (action === 'close') {
        return {
          eventType: 'pr.closed',
          repoFullName,
          prNumber,
          payload: { prNumber, action, merged: false },
        };
      }
      if (action === 'merge') {
        return {
          eventType: 'pr.merged',
          repoFullName,
          prNumber,
          payload: { prNumber, action, merged: true },
        };
      }
      if (action === 'approved') {
        return {
          eventType: 'review.approved',
          repoFullName,
          prNumber,
          payload: { prNumber, reviewer: payload.user?.username ?? null },
        };
      }
      return null;
    }

    case 'pipeline': {
      const payload = raw as PipelineHookPayload;
      const repoFullName = payload.project?.path_with_namespace ?? '';
      const status = payload.object_attributes?.status;
      const sha = payload.object_attributes?.sha;
      // Pipeline Hook payloads carry no reliable merge_request association across GitLab
      // versions/configurations — normalized with prNumber: null, resolved downstream by
      // `resolveFeatureRunId`'s head-sha fallback (the same mechanism GitHub's legacy `status`
      // webhook event already relies on).
      if (status === 'success') {
        return {
          eventType: 'check.passed',
          repoFullName,
          prNumber: null,
          payload: { sha, status },
        };
      }
      if (status === 'failed') {
        return {
          eventType: 'check.failed',
          repoFullName,
          prNumber: null,
          payload: { sha, status },
        };
      }
      return null;
    }

    case 'note': {
      const payload = raw as NoteHookPayload;
      if (payload.object_attributes?.noteable_type !== 'MergeRequest') return null;
      const repoFullName = payload.project?.path_with_namespace ?? '';
      const prNumber = payload.merge_request?.iid ?? null;
      return {
        eventType: 'review.comment',
        repoFullName,
        prNumber,
        payload: { prNumber },
      };
    }

    case 'push': {
      const payload = raw as PushHookPayload;
      const repoFullName = payload.project?.path_with_namespace ?? '';
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
