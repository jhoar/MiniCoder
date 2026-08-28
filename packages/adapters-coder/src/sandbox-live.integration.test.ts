import { describe, expect, it } from 'vitest';
import { CoderSandbox } from './sandbox.js';
import { prepareBranch, commitAndPush, type WorkspaceOptions } from './workspace.js';

/**
 * Issue #84: closes the "coder-sandbox egress-proxy allow-list and SCM_ALLOWED_HOST unverified
 * against a live Docker daemon" gap. Every other `adapters-coder` test (`sandbox.test.ts`,
 * `workspace.test.ts`) exercises this module's orchestration logic against a fake `DockerLike`
 * client or a local `ChildProcessCommandRunner` — neither proves the real
 * `infra/docker/coder-sandbox` image/`infra/docker-compose.coder-sandbox.yml` topology actually
 * works: a real ephemeral container, attached only to the isolated `internal: true` sandbox
 * network, egressing exclusively through the allow-list proxy, reaching a real self-hosted SCM
 * host only once `SCM_ALLOWED_HOST` names it.
 *
 * This suite is gated the same way the `*.postgres.test.ts` suites gate on
 * `MINICODER_TEST_PG_URL` — it is a no-op (`describe.skipIf`) unless every required env var is
 * set, so it never runs in an environment with no Docker daemon (the situation every prior phase
 * of this project has been in — see CLAUDE.md's Reference Coder Adapter Operational
 * Constraints). To exercise it for real:
 *
 *   1. Build the sandbox image (`docker build -t minicoder/coder-sandbox:latest
 *      infra/docker/coder-sandbox`) and bring up the egress proxy
 *      (`infra/docker-compose.coder-sandbox.yml`'s `coder-sandbox-egress-proxy` service) attached
 *      to the isolated `minicoder-coder-sandbox` network plus a real-egress network, once with
 *      `SCM_ALLOWED_HOST` set to a reachable Gitea/GitLab host and (optionally) once without, to
 *      exercise both CODER_SANDBOX_TEST_PROXY_ALLOW and CODER_SANDBOX_TEST_PROXY_DENY below.
 *   2. Optionally bring up `coder-sandbox-docker-proxy` too (with `DISABLE_IPV6=1` — see that
 *      compose service's own comment for why) and point `CODER_SANDBOX_TEST_DOCKER_HOST` at it,
 *      to also prove `CoderSandbox` creates/controls containers *through* that proxy rather than
 *      talking to the local Docker socket directly.
 *   3. Point this suite at that topology via the env vars below and a real repo/token on that
 *      SCM host.
 *
 * A full walkthrough (including the exact `docker run`/`docker network create` commands used to
 * verify this against a real Gitea instance, since this repo's own dev/CI sandboxes' egress
 * policy blocks `deb.debian.org`/`dl-cdn.alpinelinux.org` directly) is recorded in docs/06 §Phase
 * 18 Stage 6's issue #84 follow-up notes and CLAUDE.md's Reference Coder Adapter Operational
 * Constraints section.
 */

const RUN_LIVE = process.env['CODER_SANDBOX_LIVE_TEST'] === '1';
const IMAGE = process.env['CODER_SANDBOX_TEST_IMAGE'];
const NETWORK = process.env['CODER_SANDBOX_TEST_NETWORK'];
/** Proxy address (host:port, reachable from NETWORK) whose allow-list already includes the SCM
 * host named in SCM_TEST_REPO_URL — proves the positive case. */
const PROXY_ALLOW = process.env['CODER_SANDBOX_TEST_PROXY_ALLOW'];
/** Same shape, but the SCM host is deliberately NOT in this proxy's allow-list — proves the
 * negative (default-deny) case. Optional: the positive-case test still runs without it. */
const PROXY_DENY = process.env['CODER_SANDBOX_TEST_PROXY_DENY'];
/** `coder-sandbox-docker-proxy` address (e.g. `127.0.0.1:12375` if published to the host, or
 * `coder-sandbox-docker-proxy:2375` from inside its own network) — the same `host:port` value
 * `CODER_SANDBOX_DOCKER_HOST` takes in production. Optional: every other test still runs against
 * the local Docker socket directly without it. */
const DOCKER_HOST = process.env['CODER_SANDBOX_TEST_DOCKER_HOST'];
const REPO_URL = process.env['SCM_TEST_REPO_URL'];
const GIT_TOKEN = process.env['SCM_TEST_TOKEN'];
const REMOTE_USERNAME = process.env['SCM_TEST_USERNAME'] ?? 'token';

const RUN = RUN_LIVE && !!IMAGE && !!NETWORK && !!PROXY_ALLOW && !!REPO_URL && !!GIT_TOKEN;

function baseOptions(featureRunId: string, sandbox: CoderSandbox): WorkspaceOptions {
  return {
    workspaceDir: '/workspace',
    repoUrl: REPO_URL!,
    gitToken: GIT_TOKEN!,
    remoteUsername: REMOTE_USERNAME,
    featureRunId,
    runner: sandbox,
  };
}

describe.skipIf(!RUN)(
  'CoderSandbox against a live Docker daemon and a live SCM host (issue #84)',
  () => {
    it('clones, commits, and pushes through the sandboxed egress proxy once SCM_ALLOWED_HOST names the SCM host', async () => {
      const sandbox = new CoderSandbox({
        image: IMAGE!,
        network: NETWORK!,
        httpsProxy: PROXY_ALLOW!,
        dockerHost: DOCKER_HOST,
      });
      await sandbox.start();
      try {
        // Isolation properties (docs/07 §6 / sandbox.ts's HostConfig): non-root, all Linux
        // capabilities dropped, read-only root filesystem with only /workspace and /tmp
        // writable. Verified functionally through the same CommandRunner seam
        // workspace.ts uses — no new introspection API needed.
        const uid = await sandbox.run('id', ['-u']);
        expect(uid.stdout.trim()).toBe('10001');

        const capEff = await sandbox.run('sh', ['-c', 'grep CapEff /proc/self/status']);
        expect(capEff.stdout.trim()).toBe('CapEff:\t0000000000000000');

        const rootWrite = await sandbox.run('sh', [
          '-c',
          'touch /root-write-test 2>/dev/null; echo "exit=$?"',
        ]);
        expect(rootWrite.stdout.trim()).toBe('exit=1');

        const workspaceWrite = await sandbox.run('sh', [
          '-c',
          'touch /workspace/write-test && echo ok',
        ]);
        expect(workspaceWrite.stdout.trim()).toBe('ok');

        const featureRunId = `issue-84-verify-${Date.now()}`;
        const opts = baseOptions(featureRunId, sandbox);
        const { repoDir } = await prepareBranch(opts);

        const result = await commitAndPush(
          opts,
          repoDir,
          [
            {
              path: 'ISSUE_84_LIVE_VERIFICATION.md',
              content: `Live sandbox verification for issue #84, run ${featureRunId}.\n`,
            },
          ],
          'Issue #84 live sandbox verification',
        );

        expect(result.reusedExistingCommit).toBe(false);
        expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
        expect(result.branchName).toBe(`minicoder/${featureRunId}`);

        // Idempotent-retry check (docs/03 §11.6): re-running prepareBranch + commitAndPush for
        // the same feature run against the branch just pushed must reuse the existing commit,
        // not double-push. A real retry runs in a fresh sandbox container/workspace, so clear
        // the previous clone first rather than reusing its directory.
        await sandbox.run('rm', ['-rf', repoDir]);
        const { repoDir: repoDir2 } = await prepareBranch(opts);
        const retry = await commitAndPush(
          opts,
          repoDir2,
          [
            {
              path: 'ISSUE_84_LIVE_VERIFICATION.md',
              content: `Live sandbox verification for issue #84, run ${featureRunId}.\n`,
            },
          ],
          'Issue #84 live sandbox verification',
        );
        expect(retry.reusedExistingCommit).toBe(true);
        expect(retry.commitSha).toBe(result.commitSha);
      } finally {
        await sandbox.remove();
      }
    }, 120_000);

    it.skipIf(!PROXY_DENY)(
      'fails to reach the SCM host when SCM_ALLOWED_HOST is not set (default-deny egress)',
      async () => {
        const sandbox = new CoderSandbox({
          image: IMAGE!,
          network: NETWORK!,
          httpsProxy: PROXY_DENY!,
          dockerHost: DOCKER_HOST,
        });
        await sandbox.start();
        try {
          const featureRunId = `issue-84-verify-denied-${Date.now()}`;
          await expect(prepareBranch(baseOptions(featureRunId, sandbox))).rejects.toThrow();
        } finally {
          await sandbox.remove();
        }
      },
      60_000,
    );

    // Only meaningful when CODER_SANDBOX_TEST_DOCKER_HOST is set — otherwise every test above
    // already talks to the local Docker socket directly, which is not what this checks.
    it.skipIf(!DOCKER_HOST)(
      'creates and controls the sandbox container through coder-sandbox-docker-proxy, not the local socket',
      async () => {
        const sandbox = new CoderSandbox({
          image: IMAGE!,
          network: NETWORK!,
          httpsProxy: PROXY_ALLOW!,
          dockerHost: DOCKER_HOST,
        });
        await sandbox.start();
        try {
          const result = await sandbox.run('id', ['-u']);
          expect(result.stdout.trim()).toBe('10001');
        } finally {
          await sandbox.remove();
        }
      },
      60_000,
    );
  },
);
