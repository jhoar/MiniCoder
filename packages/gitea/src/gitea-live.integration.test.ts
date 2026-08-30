import { describe, expect, it } from 'vitest';
import { GiteaScmClient } from './gitea-client.js';

/**
 * Issue #85: closes the "no permanent CI-integrated live-instance matrix for Gitea" gap.
 * `gitea-client.ts`'s own header comment documented this client as reviewed against Gitea's
 * documented REST API shapes but never exercised against a live server in this repository's CI —
 * the docs/06 §Phase 18 Stage 6 live-verification pass that DID run it against a real Gitea 1.22.3
 * instance was exploratory manual testing with no committed regression coverage.
 *
 * Gated the same way `sandbox-live.integration.test.ts` gates on a real Docker daemon — a no-op
 * (`describe.skipIf`) unless every required env var is set, so it never runs against `pnpm test`/
 * local dev by default. The permanent CI job (`.github/workflows/live-scm-matrix.yml`, scheduled +
 * `workflow_dispatch` rather than on every push — GitLab's own live suite is much heavier, and
 * running a live-server matrix on every PR was judged disproportionate) downloads a pinned Gitea
 * release binary (no Docker needed for this half), bootstraps an admin user/access token/test
 * repo, and sets these env vars before running this file.
 *
 * A real, one-off run of this exact flow (a downloaded Gitea 1.22.3 binary, run as an unprivileged
 * OS user, migrated/bootstrapped/started, with a real repo/branch/PR/merge cycle exercised through
 * this file's own battery) found one genuinely new thing no amount of documentation review
 * surfaced: `getPullRequest()`'s `mergeable` flag is computed asynchronously after PR creation —
 * calling `mergePullRequest()` immediately after `createPullRequest()` reliably 405s even for a
 * trivially mergeable PR, since Gitea hasn't finished computing mergeability yet. This file's
 * `waitForMergeable()` polls for it (bounded, matching this client's own `MAX_PAGES`-style
 * defensive-cap posture) before merging — a caller wanting the real fix (not just a test
 * workaround) would need the identical wait in `run-merge-gate.ts`/`merge.ts`, tracked as a
 * separate, real follow-up (issue reference in CLAUDE.md) rather than silently folded into this
 * PR's scope.
 */

const RUN_LIVE = process.env['MINICODER_TEST_LIVE_GITEA'] === '1';
const BASE_URL = process.env['GITEA_LIVE_BASE_URL'];
const TOKEN = process.env['GITEA_LIVE_TOKEN'];
const OWNER = process.env['GITEA_LIVE_OWNER'] ?? 'testadmin';
const REPO = process.env['GITEA_LIVE_REPO'] ?? 'widgets';

const RUN = RUN_LIVE && !!BASE_URL && !!TOKEN;

async function waitForMergeable(
  client: GiteaScmClient,
  owner: string,
  repo: string,
  prNumber: number,
  attempts = 20,
  delayMs = 500,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const observed = await client.getPullRequest(owner, repo, prNumber);
    if (observed?.mergeable) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

describe.skipIf(!RUN)('GiteaScmClient against a live Gitea instance (issue #85)', () => {
  it('exercises the full ScmClient battery — branch, PR, diff, status, merge — against a real server', async () => {
    const client = new GiteaScmClient({ baseUrl: BASE_URL!, token: TOKEN! });

    const branchesRes = await fetch(`${BASE_URL}/api/v1/repos/${OWNER}/${REPO}/branches/main`, {
      headers: { Authorization: `token ${TOKEN}` },
    });
    expect(branchesRes.ok).toBe(true);
    const mainBranch = (await branchesRes.json()) as { commit: { id: string } };
    const headSha = mainBranch.commit.id;

    const branchName = `issue-85-live-${Date.now()}`;
    const branch = await client.createBranch({
      owner: OWNER,
      repo: REPO,
      branchName,
      fromSha: headSha,
    });
    expect(branch.branchName).toBe(branchName);

    // A branch with no diff from its base cannot be usefully merged — add a real commit via
    // Gitea's contents API before opening the PR, the same way any real coder-adapter push would.
    const fileRes = await fetch(
      `${BASE_URL}/api/v1/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(`${branchName}.txt`)}`,
      {
        method: 'POST',
        headers: { Authorization: `token ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: Buffer.from('live-instance regression content\n').toString('base64'),
          message: 'issue #85 live regression commit',
          branch: branchName,
        }),
      },
    );
    expect(fileRes.ok).toBe(true);

    const pr = await client.createPullRequest({
      owner: OWNER,
      repo: REPO,
      branchName,
      baseBranch: 'main',
      title: `Live test PR (${branchName})`,
      body: 'Opened by gitea-live.integration.test.ts',
    });
    expect(pr.prNumber).toBeGreaterThan(0);

    const observed = await client.getPullRequest(OWNER, REPO, pr.prNumber);
    expect(observed).toMatchObject({
      prNumber: pr.prNumber,
      branchName,
      baseBranch: 'main',
      state: 'open',
    });

    const diff = await client.getPullRequestDiff(OWNER, REPO, pr.prNumber);
    expect(diff).toContain(`${branchName}.txt`);

    const listed = await client.listPullRequestsForBranch(OWNER, REPO, branchName, 'open');
    expect(listed).toEqual([{ prNumber: pr.prNumber, state: 'open' }]);

    const prHeadSha = observed!.headSha;
    expect(prHeadSha).toBeTruthy();
    await client.publishStatusCheck({
      owner: OWNER,
      repo: REPO,
      sha: prHeadSha!,
      state: 'success',
      context: 'minicoder/review-gate',
      description: 'issue #85 live regression',
      targetUrl: 'https://example.test',
    });

    await waitForMergeable(client, OWNER, REPO, pr.prNumber);
    const merge = await client.mergePullRequest({
      owner: OWNER,
      repo: REPO,
      prNumber: pr.prNumber,
      mergeMethod: 'merge',
      commitTitle: `Merge ${branchName}`,
      commitMessage: 'issue #85 live regression merge',
    });
    expect(merge.mergeSha).toBeTruthy();

    const afterMerge = await client.getPullRequest(OWNER, REPO, pr.prNumber);
    expect(afterMerge?.state).toBe('merged');
  }, 60_000);
});
