/**
 * Stage 5 acceptance (docs/06 §Phase 18 "Generic SCM Interface"): a cross-provider conformance
 * suite driving one fixture PR lifecycle through all three shipped `ScmClient` implementations —
 * GitHub, Gitea, GitLab — and asserting the `ObservedPullRequestState` contract holds identically
 * (same field types, same enum membership) across all three. A handful of fields are explicitly
 * documented, per-provider exceptions rather than asserted equal across providers — this suite
 * proves the *shape* of the contract holds everywhere, not that every provider observes identical
 * values for a field that is, by this plan's own "lowest common denominator, documented not
 * silently absorbed" framing, legitimately provider-specific:
 *
 *   - `conversationsResolved`: a real, per-provider-varying observation (GitHub's GraphQL-backed
 *     check, GitLab's native discussions API) vs. Gitea's hardcoded `false` placeholder (Gitea's
 *     REST API has no such field — see `gitea-client.ts`'s header comment).
 *   - `getRemainingRateLimit()`: GitHub's mock returns a concrete number; Gitea/GitLab return a
 *     large sentinel (`Number.MAX_SAFE_INTEGER`) since neither has a standard, always-available
 *     rate-limit-remaining endpoint — both are still typed `number`, just not comparable in value.
 *   - `getPullRequestDiff()`: Gitea's `.diff` endpoint returns a real unified diff; GitLab's is a
 *     synthesized approximation from structured per-file entries (`gitlab-client.ts`'s header
 *     comment); both are still non-empty strings starting with `diff --git`.
 *
 * **Scope decision — not a Phase-5-style registry-driven framework.** Phase 5's
 * `runConformanceSuite()` (`packages/testing/src/conformance/`) exists to test *swappable,
 * independently-authored* adapter implementations behind a role interface, persisting a historical
 * audit trail (`adapter_conformance_results`) across repeated runs against a real deployment. There
 * are only three `ScmClient` implementations, ever — one per real, named SCM provider, not an open
 * set of pluggable third-party adapters — and there is no live, historical-audit-needing caller of
 * this suite the way `AdapterRegistry`-backed adapters have. A parametrized Vitest suite exercising
 * all three on every CI run is the proportionate shape for what this stage actually needs; building
 * a second `*_conformance_results`-style DB-writing framework for a fixed set of three
 * implementations would be exactly the kind of unused, half-finished abstraction CLAUDE.md's own
 * operating principles warn against.
 *
 * **GitHub substitution, documented not hidden.** `OctokitGitHubClient` (`packages/github`) has no
 * injectable HTTP-mocking seam in this codebase — `octokit-client.test.ts` only unit-tests its pure
 * `deriveCiStatus`/`deriveReviewState` helpers, never drives the class itself against mocked HTTP —
 * and this environment has no live GitHub credential to exercise it for real. `MockGitHubClient`
 * (`./services/mock-github-client.ts`) stands in instead: the same deterministic `ScmClient` test
 * seam every other GitHub-facing scenario in this codebase already substitutes for a live Octokit
 * call (docs/04 §3.2 "Mock Providers by Default"). This is a documented substitution, not a claim
 * that `OctokitGitHubClient` itself was exercised end-to-end here.
 *
 * **CI matrix.** No new CI workflow dimension was added. Unlike docs/04 §12's mandatory
 * SQLite/PostgreSQL matrix (two genuinely different database engines the same code must run
 * against), this suite runs entirely against fake-`fetch`/in-memory fixtures with no live daemon
 * dependency — it already runs in every ordinary `pnpm test`/CI invocation with no extra wiring. A
 * literal live-instance matrix (real Gitea + real GitLab containers alongside a real/sandboxed
 * GitHub target) remains a real, documented gap, not silently dropped: this environment has no
 * reachable Docker daemon (the same constraint already documented in
 * `infra/docker-compose.{gitea,gitlab}.yml`'s own header comments and CLAUDE.md's Reference Coder
 * Adapter notes on the sandbox), so that dimension could not be built or verified here.
 */
import { describe, it, expect } from 'vitest';
import type { ScmClient, ObservedPullRequestState } from '@minicoder/core';
import { PrReviewState, ScmMergeRejectedError } from '@minicoder/core';
import { GiteaScmClient } from '@minicoder/gitea';
import { GitlabScmClient } from '@minicoder/gitlab';
import { MockGitHubClient } from './services/mock-github-client.js';
import { MockGitHubProvider } from './services/mock-github-provider.js';

const OWNER = 'acme';
const REPO = 'widgets';
const BRANCH = 'minicoder/run-conformance-1';
const BASE_BRANCH = 'main';

interface FakeRoute {
  method: string;
  path: string;
  status?: number;
  body?: unknown;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

/** Shared fake-fetch route matcher — the "prefer a full path match over a mere prefix match"
 * algorithm found and fixed during Stages 3/4 (`.../pulls/7` must not win against
 * `.../pulls/7/reviews` just because it's a shorter string). */
function fakeFetch(routes: FakeRoute[]): typeof fetch {
  return (async (input: unknown, init?: { method?: string }) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const candidates = routes
      .filter((r) => r.method === method)
      .map((r) => {
        const index = url.indexOf(r.path);
        if (index === -1) return null;
        const suffix = url.slice(index + r.path.length);
        const isFullMatch = suffix === '' || suffix.startsWith('?');
        return { route: r, isFullMatch, pathLength: r.path.length };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const match = candidates.sort((a, b) => {
      if (a.isFullMatch !== b.isFullMatch) return a.isFullMatch ? -1 : 1;
      return b.pathLength - a.pathLength;
    })[0]?.route;
    if (!match) {
      throw new Error(`fakeFetch: no route registered for ${method} ${url}`);
    }
    // Gitea's `.diff` endpoint literally returns raw diff text, not JSON — special-cased the same
    // way `gitea-client.test.ts`'s own fakeFetch is. GitLab's `/diffs` endpoint (used below)
    // returns real JSON (structured per-file diff entries), so it is deliberately NOT special-cased
    // here and goes through the normal `jsonResponse()` path.
    if (match.path.endsWith('.diff')) {
      return {
        ok: (match.status ?? 200) < 300,
        status: match.status ?? 200,
        text: async () => (match.body as string) ?? '',
      } as Response;
    }
    return jsonResponse(match.status ?? 200, match.body);
  }) as typeof fetch;
}

/** Asserts the structural contract every `ObservedPullRequestState` must satisfy, regardless of
 * provider — field presence and type/enum membership, not cross-provider value equality (several
 * fields are documented, legitimate per-provider exceptions — see this file's header comment). */
function assertValidObservedPullRequestState(observed: ObservedPullRequestState): void {
  expect(typeof observed.prNumber).toBe('number');
  expect(typeof observed.branchName).toBe('string');
  expect(typeof observed.baseBranch).toBe('string');
  expect(observed.headSha === null || typeof observed.headSha === 'string').toBe(true);
  expect(['open', 'closed', 'merged']).toContain(observed.state);
  expect(Object.values(PrReviewState)).toContain(observed.reviewState);
  expect(['pending', 'running', 'passed', 'failed']).toContain(observed.ciStatus);
  expect(observed.mergeable === null || typeof observed.mergeable === 'boolean').toBe(true);
  expect(Array.isArray(observed.blockingLabels)).toBe(true);
  expect(observed.blockingLabels.every((l) => typeof l === 'string')).toBe(true);
  expect(typeof observed.conversationsResolved).toBe('boolean');
  expect(observed.mergedAt === null || typeof observed.mergedAt === 'string').toBe(true);
  expect(observed.mergeSha === null || typeof observed.mergeSha === 'string').toBe(true);
  expect(observed.closedAt === null || typeof observed.closedAt === 'string').toBe(true);
}

interface ProviderHarness {
  name: string;
  /** PR open, no reviews yet, CI still running. */
  buildPendingReviewClient(prNumber: number): ScmClient;
  /** PR open, approved, CI passed, mergeable. */
  buildApprovedPassingClient(prNumber: number): ScmClient;
  /** PR merged. */
  buildMergedClient(prNumber: number, mergeSha: string): ScmClient;
  /** A client whose `mergePullRequest()` call succeeds. */
  buildMergeCapableClient(prNumber: number, mergeSha: string): ScmClient;
  /** A client whose `mergePullRequest()` call is rejected as not mergeable. */
  buildMergeRejectedClient(prNumber: number): ScmClient;
  buildDiffClient(prNumber: number): ScmClient;
  buildListBranchClient(prNumber: number): ScmClient;
}

function githubHarness(): ProviderHarness {
  function clientWithPr(setup: (provider: MockGitHubProvider, prNumber: number) => void) {
    return (prNumber: number) => {
      const provider = new MockGitHubProvider();
      // Every PR is opened against the same fixed feature-run id so its derived branch name
      // (`minicoder/<featureRunId>`, MockGitHubClient's own convention) always resolves to the
      // shared `BRANCH` constant this suite's `listPullRequestsForBranch()` test looks for,
      // regardless of which PR number a given scenario uses.
      provider.simulatePrOpened(prNumber, 'run-conformance-1', `sha-${prNumber}`);
      setup(provider, prNumber);
      return new MockGitHubClient(provider);
    };
  }

  return {
    name: 'github (MockGitHubClient)',
    buildPendingReviewClient: clientWithPr(() => {
      // Freshly opened: no reviews, no checks yet — matches MockGitHubProvider's own initial state.
    }),
    buildApprovedPassingClient: clientWithPr((provider, prNumber) => {
      provider.simulateReviewApproved(prNumber, 'reviewer-1');
      provider.simulateCheckPassed(prNumber, 'ci');
    }),
    buildMergedClient: (prNumber, mergeSha) =>
      clientWithPr((provider, pr) => {
        provider.simulateReviewApproved(pr, 'reviewer-1');
        provider.simulateCheckPassed(pr, 'ci');
        provider.simulatePrMerged(pr, mergeSha);
      })(prNumber),
    buildMergeCapableClient: (prNumber) => clientWithPr(() => {})(prNumber),
    buildMergeRejectedClient: (prNumber) =>
      clientWithPr((provider, pr) => {
        provider.simulateMergeConflict(pr, 'not_mergeable');
      })(prNumber),
    buildDiffClient: (prNumber) => clientWithPr(() => {})(prNumber),
    buildListBranchClient: (prNumber) => clientWithPr(() => {})(prNumber),
  };
}

function giteaHarness(): ProviderHarness {
  const BASE = { baseUrl: 'https://gitea.example.test', token: 'tok' };

  function prJson(prNumber: number, opts: { merged?: boolean; mergeable?: boolean | null } = {}) {
    return {
      number: prNumber,
      state: opts.merged ? 'closed' : 'open',
      merged: opts.merged ?? false,
      merged_at: opts.merged ? '2026-01-01T00:00:00Z' : null,
      merge_commit_sha: opts.merged ? `merge-sha-${prNumber}` : null,
      closed_at: opts.merged ? '2026-01-01T00:00:00Z' : null,
      mergeable: opts.mergeable ?? true,
      head: { ref: BRANCH, sha: `sha-${prNumber}` },
      base: { ref: BASE_BRANCH },
      labels: [],
    };
  }

  return {
    name: 'gitea (GiteaScmClient)',
    buildPendingReviewClient: (prNumber) =>
      new GiteaScmClient({
        ...BASE,
        fetchImpl: fakeFetch([
          { method: 'GET', path: `/pulls/${prNumber}`, body: prJson(prNumber) },
          { method: 'GET', path: `/pulls/${prNumber}/reviews`, body: [] },
          { method: 'GET', path: `/commits/sha-${prNumber}/status`, body: { state: 'pending' } },
        ]),
      }),
    buildApprovedPassingClient: (prNumber) =>
      new GiteaScmClient({
        ...BASE,
        fetchImpl: fakeFetch([
          { method: 'GET', path: `/pulls/${prNumber}`, body: prJson(prNumber) },
          {
            method: 'GET',
            path: `/pulls/${prNumber}/reviews`,
            body: [
              { state: 'APPROVED', user: { login: 'alice' }, submitted_at: '2026-01-01T00:00:00Z' },
            ],
          },
          { method: 'GET', path: `/commits/sha-${prNumber}/status`, body: { state: 'success' } },
        ]),
      }),
    buildMergedClient: (prNumber, mergeSha) =>
      new GiteaScmClient({
        ...BASE,
        fetchImpl: fakeFetch([
          {
            method: 'GET',
            path: `/pulls/${prNumber}`,
            body: { ...prJson(prNumber, { merged: true }), merge_commit_sha: mergeSha },
          },
          {
            method: 'GET',
            path: `/pulls/${prNumber}/reviews`,
            body: [
              { state: 'APPROVED', user: { login: 'alice' }, submitted_at: '2026-01-01T00:00:00Z' },
            ],
          },
          { method: 'GET', path: `/commits/sha-${prNumber}/status`, body: { state: 'success' } },
        ]),
      }),
    buildMergeCapableClient: (prNumber, mergeSha) =>
      new GiteaScmClient({
        ...BASE,
        fetchImpl: fakeFetch([
          { method: 'POST', path: `/pulls/${prNumber}/merge`, body: {} },
          {
            method: 'GET',
            path: `/pulls/${prNumber}`,
            body: { ...prJson(prNumber, { merged: true }), merge_commit_sha: mergeSha },
          },
        ]),
      }),
    buildMergeRejectedClient: (prNumber) =>
      new GiteaScmClient({
        ...BASE,
        fetchImpl: fakeFetch([{ method: 'POST', path: `/pulls/${prNumber}/merge`, status: 405 }]),
      }),
    buildDiffClient: (prNumber) =>
      new GiteaScmClient({
        ...BASE,
        fetchImpl: fakeFetch([
          {
            method: 'GET',
            path: `/pulls/${prNumber}.diff`,
            body: `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n`,
          },
        ]),
      }),
    buildListBranchClient: (prNumber) =>
      new GiteaScmClient({
        ...BASE,
        fetchImpl: fakeFetch([{ method: 'GET', path: `/pulls`, body: [prJson(prNumber)] }]),
      }),
  };
}

function gitlabHarness(): ProviderHarness {
  const BASE = { baseUrl: 'https://gitlab.example.test', token: 'tok' };
  const projectPath = `/projects/${encodeURIComponent(`${OWNER}/${REPO}`)}`;

  function mrJson(prNumber: number, opts: { merged?: boolean; mergeStatus?: string | null } = {}) {
    return {
      iid: prNumber,
      state: opts.merged ? 'merged' : 'opened',
      merged_at: opts.merged ? '2026-01-01T00:00:00Z' : null,
      merge_commit_sha: opts.merged ? `merge-sha-${prNumber}` : null,
      closed_at: null,
      sha: `sha-${prNumber}`,
      source_branch: BRANCH,
      target_branch: BASE_BRANCH,
      labels: [],
      merge_status: opts.mergeStatus === undefined ? 'can_be_merged' : opts.mergeStatus,
    };
  }

  return {
    name: 'gitlab (GitlabScmClient)',
    buildPendingReviewClient: (prNumber) =>
      new GitlabScmClient({
        ...BASE,
        fetchImpl: fakeFetch([
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}`,
            body: mrJson(prNumber),
          },
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}/approvals`,
            // No approval requirement configured yet and no discussions -> deriveReviewState()
            // returns NONE, matching "freshly opened, no review activity yet" on the other two
            // providers (GitHub/Gitea report NONE when there are simply zero reviews).
            body: { approvals_required: 0, approvals_left: 0 },
          },
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}/discussions`,
            body: [],
          },
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}/pipelines`,
            body: [{ status: 'running' }],
          },
        ]),
      }),
    buildApprovedPassingClient: (prNumber) =>
      new GitlabScmClient({
        ...BASE,
        fetchImpl: fakeFetch([
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}`,
            body: mrJson(prNumber),
          },
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}/approvals`,
            body: { approvals_required: 1, approvals_left: 0 },
          },
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}/discussions`,
            body: [],
          },
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}/pipelines`,
            body: [{ status: 'success' }],
          },
        ]),
      }),
    buildMergedClient: (prNumber, mergeSha) =>
      new GitlabScmClient({
        ...BASE,
        fetchImpl: fakeFetch([
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}`,
            body: { ...mrJson(prNumber, { merged: true }), merge_commit_sha: mergeSha },
          },
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}/approvals`,
            body: { approvals_required: 1, approvals_left: 0 },
          },
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}/discussions`,
            body: [],
          },
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}/pipelines`,
            body: [{ status: 'success' }],
          },
        ]),
      }),
    buildMergeCapableClient: (prNumber, mergeSha) =>
      new GitlabScmClient({
        ...BASE,
        fetchImpl: fakeFetch([
          {
            method: 'PUT',
            path: `${projectPath}/merge_requests/${prNumber}/merge`,
            body: { ...mrJson(prNumber, { merged: true }), merge_commit_sha: mergeSha },
          },
        ]),
      }),
    buildMergeRejectedClient: (prNumber) =>
      new GitlabScmClient({
        ...BASE,
        fetchImpl: fakeFetch([
          {
            method: 'PUT',
            path: `${projectPath}/merge_requests/${prNumber}/merge`,
            status: 405,
          },
        ]),
      }),
    buildDiffClient: (prNumber) =>
      new GitlabScmClient({
        ...BASE,
        fetchImpl: fakeFetch([
          {
            method: 'GET',
            path: `${projectPath}/merge_requests/${prNumber}/diffs`,
            body: [{ old_path: 'x.ts', new_path: 'x.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }],
          },
        ]),
      }),
    buildListBranchClient: (prNumber) =>
      new GitlabScmClient({
        ...BASE,
        fetchImpl: fakeFetch([
          {
            method: 'GET',
            path: `${projectPath}/merge_requests`,
            body: [mrJson(prNumber)],
          },
        ]),
      }),
  };
}

const harnesses: ProviderHarness[] = [githubHarness(), giteaHarness(), gitlabHarness()];

describe('Cross-provider ScmClient conformance (docs/06 §Phase 18 Stage 5)', () => {
  describe.each(harnesses.map((h) => [h.name, h] as const))('%s', (_name, harness) => {
    it('getPullRequest() reports a structurally valid state for a freshly-opened PR pending review', async () => {
      const client = harness.buildPendingReviewClient(101);
      const observed = await client.getPullRequest(OWNER, REPO, 101);
      expect(observed).not.toBeNull();
      assertValidObservedPullRequestState(observed!);
      expect(observed!.state).toBe('open');
      expect(observed!.reviewState).toBe(PrReviewState.NONE);
    });

    it('getPullRequest() reports a structurally valid state for an approved, CI-passing PR', async () => {
      const client = harness.buildApprovedPassingClient(102);
      const observed = await client.getPullRequest(OWNER, REPO, 102);
      expect(observed).not.toBeNull();
      assertValidObservedPullRequestState(observed!);
      expect(observed!.state).toBe('open');
      expect(observed!.reviewState).toBe(PrReviewState.APPROVED);
      expect(observed!.ciStatus).toBe('passed');
    });

    it('getPullRequest() reports a structurally valid state for a merged PR', async () => {
      const client = harness.buildMergedClient(103, 'merge-sha-103');
      const observed = await client.getPullRequest(OWNER, REPO, 103);
      expect(observed).not.toBeNull();
      assertValidObservedPullRequestState(observed!);
      expect(observed!.state).toBe('merged');
      expect(observed!.mergedAt).not.toBeNull();
      expect(observed!.mergeSha).toBe('merge-sha-103');
    });

    it('mergePullRequest() succeeds and returns a mergeSha', async () => {
      const client = harness.buildMergeCapableClient(104, 'merge-sha-104');
      const result = await client.mergePullRequest({
        owner: OWNER,
        repo: REPO,
        prNumber: 104,
        mergeMethod: 'merge',
      });
      expect(typeof result.mergeSha).toBe('string');
    });

    it('mergePullRequest() rejects a not-mergeable PR with a classified ScmMergeRejectedError', async () => {
      const client = harness.buildMergeRejectedClient(105);
      await expect(
        client.mergePullRequest({
          owner: OWNER,
          repo: REPO,
          prNumber: 105,
          mergeMethod: 'merge',
        }),
      ).rejects.toThrow(ScmMergeRejectedError);
    });

    it('getPullRequestDiff() returns a non-empty unified-diff-shaped string', async () => {
      const client = harness.buildDiffClient(106);
      const diff = await client.getPullRequestDiff(OWNER, REPO, 106);
      expect(typeof diff).toBe('string');
      expect(diff.length).toBeGreaterThan(0);
      expect(diff).toContain('diff --git');
    });

    it('listPullRequestsForBranch() finds the matching PR', async () => {
      const client = harness.buildListBranchClient(107);
      const matches = await client.listPullRequestsForBranch(OWNER, REPO, BRANCH, 'open');
      expect(matches).toEqual([{ prNumber: 107, state: 'open' }]);
    });

    it('getRemainingRateLimit() returns a finite, non-negative number', async () => {
      const client = harness.buildPendingReviewClient(108);
      const remaining = await client.getRemainingRateLimit();
      expect(typeof remaining).toBe('number');
      expect(Number.isFinite(remaining) || remaining === Number.MAX_SAFE_INTEGER).toBe(true);
      expect(remaining).toBeGreaterThanOrEqual(0);
    });
  });
});
