/**
 * Provider-neutral "view this PR/MR on its SCM provider" web-UI link builder (docs/06 §Phase 18
 * Stage 6 — Operator-facing rollout). Pure string formatting only — no HTTP call, no `ScmClient`
 * dependency — so `getPullRequestByFeatureRun()`/`listPullRequests()`
 * (`packages/api/src/read-models/features.ts`) can call it cheaply for every row without an extra
 * network round trip. Centralized here (server-side, in the API) rather than duplicated in the Web
 * UI and Text UI: `packages/web` deliberately carries `@minicoder/api` only as a type-only
 * devDependency (CLAUDE.md's Next.js Web UI Operational Constraints), so it cannot call a runtime
 * function from this package — building the link once here and shipping it as a plain string field
 * on `PullRequestRow` is the only shape that works for both consumers without adding a
 * provider-URL-formatting dependency to the Web UI.
 *
 * The three shipped providers use structurally different URL shapes for the same concept:
 *   - GitHub: `https://github.com/{owner}/{repo}/pull/{n}` — fixed host, no `baseUrl` needed.
 *   - Gitea:  `{baseUrl}/{owner}/{repo}/pulls/{n}` — self-hosted, `baseUrl` required.
 *   - GitLab: `{baseUrl}/{owner}/{repo}/-/merge_requests/{n}` — self-hosted, `baseUrl` required.
 *
 * Returns `null` rather than throwing on an unrecognized provider or a missing required `baseUrl`
 * — this is a display convenience for an operator-facing link, not a correctness-critical
 * computation; a caller should silently omit the link, not fail the page, when it can't be built.
 */
export function buildScmPullRequestUrl(
  provider: string,
  baseUrl: string | null,
  owner: string,
  repo: string,
  prNumber: number,
): string | null {
  switch (provider) {
    case 'github':
      return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
    case 'gitea':
      return baseUrl ? `${baseUrl.replace(/\/+$/, '')}/${owner}/${repo}/pulls/${prNumber}` : null;
    case 'gitlab':
      return baseUrl
        ? `${baseUrl.replace(/\/+$/, '')}/${owner}/${repo}/-/merge_requests/${prNumber}`
        : null;
    default:
      return null;
  }
}
