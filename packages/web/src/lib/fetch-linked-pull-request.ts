import type { PullRequestRow } from '@minicoder/api';
import { ApiClient, ApiError } from './api-client';

/** A feature run genuinely has no linked PR yet (before `code_pushed`) — that's a 404, not a
 * failure, and should render as "no pull request" rather than an error. Any other failure (5xx,
 * network, auth) must not be silently swallowed the same way, or a real API/backend problem looks
 * identical to the normal no-PR-yet case (caught in PR review). Lives in `lib/` (not inline in
 * `features/[id]/page.tsx`) specifically so it stays importable from a plain Vitest unit test —
 * this file has no `server-only` import, unlike `api-server.ts`. */
export async function fetchLinkedPullRequest(
  client: ApiClient,
  featureRunId: string,
): Promise<PullRequestRow | null> {
  try {
    return await client.getPullRequestByFeatureRun(featureRunId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
