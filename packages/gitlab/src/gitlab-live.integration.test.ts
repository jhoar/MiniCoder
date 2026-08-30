import { describe, expect, it } from 'vitest';
import { GitlabScmClient } from './gitlab-client.js';

/**
 * Issue #85: closes the "no permanent CI-integrated live-instance matrix for GitLab" gap.
 * `gitlab-client.ts`'s own header comment already documents a one-off, exploratory
 * live-verification pass (docs/06 §Phase 18 Stage 6) against a real GitLab CE 17.5.2 instance that
 * found and fixed two real bugs (`getPullRequestDiff()`'s `per_page` pagination crash,
 * `mergePullRequest()`'s empty-`merge_commit_message` rejection) — that pass had no committed
 * regression coverage proving the fix against a real server over time, only fake-`fetchImpl` unit
 * tests proving the fix's logic in isolation.
 *
 * Gated the same way `gitea-live.integration.test.ts`/`sandbox-live.integration.test.ts` gate — a
 * no-op (`describe.skipIf`) unless every required env var is set. The permanent CI job
 * (`.github/workflows/live-scm-matrix.yml`, scheduled + `workflow_dispatch` — GitLab CE's own
 * multi-minute boot time makes an on-every-push job disproportionate) brings up
 * `infra/docker-compose.gitlab.yml` (pulling the image via the `mirror.gcr.io` Docker Hub mirror
 * workaround if the runner's own network policy blocks Docker Hub directly, exactly as the
 * original live-verification pass needed to), bootstraps a root personal access token via
 * `gitlab-rails runner` (no interactive login needed), and sets these env vars before running this
 * file.
 *
 * Both original bugs get a direct, dedicated assertion here (not just incidental coverage from the
 * main battery), so a regression in either fix fails this suite specifically:
 *   - `getPullRequestDiff()` is called against a real MR and must not throw/500 — this is the
 *     exact call shape (`GET .../diffs?page=N`, no `per_page`) that crashed before the fix.
 *   - `mergePullRequest()` is called with an explicit empty-string `commitMessage` and must
 *     SUCCEED — the fix treats an empty string as "no message supplied" and omits the field
 *     entirely, rather than sending the literal `''` GitLab rejects with a 422.
 *
 * A real live run of this exact flow found one more genuinely new thing: GitLab computes an MR's
 * diff asynchronously after creation — `getPullRequestDiff()` called immediately after
 * `createPullRequest()` reliably returns an empty diff (confirmed directly against the raw
 * `GET .../diffs` endpoint: `[]` immediately after MR creation, populated ~1s later), the same
 * class of "the client isn't wrong, the server just hasn't finished computing yet" timing gap
 * `gitea-live.integration.test.ts`'s `mergeable`-polling finding documents for Gitea.
 * `waitForNonEmptyDiff()` below polls for it. A real production caller (`run-review.ts`, which
 * fetches the diff to hand to the AI reviewer) could observe the same empty-diff race on a
 * freshly-opened PR/MR; the identical fix (a bounded wait/retry before trusting an empty diff)
 * would need to land there too — tracked as a separate follow-up, not silently folded into this
 * fix, matching how the Gitea `mergeable` finding was handled.
 */

const RUN_LIVE = process.env['MINICODER_TEST_LIVE_GITLAB'] === '1';
const BASE_URL = process.env['GITLAB_LIVE_BASE_URL'];
const TOKEN = process.env['GITLAB_LIVE_TOKEN'];
const OWNER = process.env['GITLAB_LIVE_OWNER'] ?? 'root';
const REPO = process.env['GITLAB_LIVE_REPO'] ?? 'widgets';

const RUN = RUN_LIVE && !!BASE_URL && !!TOKEN;

async function waitForNonEmptyDiff(
  client: GitlabScmClient,
  owner: string,
  repo: string,
  prNumber: number,
  attempts = 20,
  delayMs = 500,
): Promise<string> {
  for (let i = 0; i < attempts; i += 1) {
    const diff = await client.getPullRequestDiff(owner, repo, prNumber);
    if (diff.length > 0) return diff;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return '';
}

describe.skipIf(!RUN)('GitlabScmClient against a live GitLab instance (issue #85)', () => {
  it('exercises the full ScmClient battery — branch, MR, diff, status, merge — against a real server', async () => {
    const client = new GitlabScmClient({ baseUrl: BASE_URL!, token: TOKEN! });
    const projectPath = encodeURIComponent(`${OWNER}/${REPO}`);

    const branchInfoRes = await fetch(
      `${BASE_URL}/api/v4/projects/${projectPath}/repository/branches/main`,
      { headers: { 'PRIVATE-TOKEN': TOKEN! } },
    );
    expect(branchInfoRes.ok).toBe(true);
    const mainBranch = (await branchInfoRes.json()) as { commit: { id: string } };
    const headSha = mainBranch.commit.id;

    const branchName = `issue-85-live-${Date.now()}`;
    const branch = await client.createBranch({
      owner: OWNER,
      repo: REPO,
      branchName,
      fromSha: headSha,
    });
    expect(branch.branchName).toBe(branchName);

    const fileRes = await fetch(
      `${BASE_URL}/api/v4/projects/${projectPath}/repository/files/${encodeURIComponent(`${branchName}.txt`)}`,
      {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': TOKEN!, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branch: branchName,
          content: 'live-instance regression content\n',
          commit_message: 'issue #85 live regression commit',
        }),
      },
    );
    expect(fileRes.ok).toBe(true);

    const pr = await client.createPullRequest({
      owner: OWNER,
      repo: REPO,
      branchName,
      baseBranch: 'main',
      title: `Live test MR (${branchName})`,
      body: 'Opened by gitlab-live.integration.test.ts',
    });
    expect(pr.prNumber).toBeGreaterThan(0);

    const observed = await client.getPullRequest(OWNER, REPO, pr.prNumber);
    expect(observed).toMatchObject({
      prNumber: pr.prNumber,
      branchName,
      baseBranch: 'main',
      state: 'open',
    });

    // Regression for the pagination bug fixed in getPullRequestDiff()'s own doc comment: this
    // call must not throw/500 (it did, reliably, whenever the fixed code path's `per_page` guard
    // regressed and the call started supplying `per_page` to GitLab's diffs endpoint again).
    // Polls first — GitLab computes the diff asynchronously after MR creation (see this file's own
    // module doc comment) — so an immediate empty result here would be a false failure, not proof
    // of a real regression.
    const diff = await waitForNonEmptyDiff(client, OWNER, REPO, pr.prNumber);
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

    // Regression for the empty-commit-message bug fixed in mergePullRequest()'s own doc comment:
    // before the fix, sending a literal `merge_commit_message: ''` made GitLab reject the merge
    // outright with a 422. The fix treats an empty string the same as "no message supplied" and
    // omits the field entirely — so this call must SUCCEED, proving the guard actually protects
    // the caller rather than merely reclassifying the same rejection.
    const merge = await client.mergePullRequest({
      owner: OWNER,
      repo: REPO,
      prNumber: pr.prNumber,
      mergeMethod: 'merge',
      commitTitle: `Merge ${branchName}`,
      commitMessage: '',
    });
    expect(merge.mergeSha).toBeTruthy();

    const afterMerge = await client.getPullRequest(OWNER, REPO, pr.prNumber);
    expect(afterMerge?.state).toBe('merged');
  }, 60_000);
});
