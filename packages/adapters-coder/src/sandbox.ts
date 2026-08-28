import Docker from 'dockerode';
import type { CommandRunner, CommandResult } from './command-runner.js';

/**
 * Minimal subset of dockerode's API this module actually uses — lets unit tests inject a fake
 * client instead of requiring a live Docker daemon (there is no Docker daemon in most CI/dev
 * environments this code runs unit tests in). The real `Docker` class from `dockerode` already
 * satisfies this shape structurally.
 */
export interface DockerLike {
  createContainer(options: Docker.ContainerCreateOptions): Promise<DockerContainerLike>;
}

export interface DockerContainerLike {
  start(): Promise<void>;
  exec(options: Docker.ExecCreateOptions): Promise<DockerExecLike>;
  remove(options?: { force?: boolean }): Promise<void>;
}

export interface DockerExecLike {
  start(options: Docker.ExecStartOptions): Promise<NodeJS.ReadableStream>;
  inspect(): Promise<{ ExitCode: number | null }>;
}

/** A running sandbox: runs commands (`CommandRunner`) plus lifecycle control. `CoderSandbox`
 * implements this; tests can substitute any other implementation. */
export interface Sandbox extends CommandRunner {
  start(): Promise<void>;
  remove(): Promise<void>;
}

export interface SandboxOptions {
  /** Docker socket/proxy the sandbox talks to (e.g. `coder-sandbox-docker-proxy` — see
   * infra/docker-compose.coder-sandbox.yml). Defaults to the local docker.sock. */
  readonly dockerHost?: string;
  readonly image: string;
  /** The isolated, egress-restricted network (see docs/07 §6 / infra/docker-compose.coder-sandbox.yml). */
  readonly network: string;
  readonly httpsProxy?: string;
  readonly cpus?: number;
  readonly memoryBytes?: number;
  readonly docker?: DockerLike;
}

/**
 * Owns the ephemeral, per-run sandbox container lifecycle (docs/03 §11.1/§11.5, docs/07 §6):
 * create from the pre-baked image, attach only to the isolated sandbox network, run commands via
 * `docker exec` (implements `CommandRunner` so `workspace.ts`'s git orchestration runs unmodified
 * inside the container), and always remove the container in the caller's `finally` — success,
 * failure, or cancellation. Resource limits (cpu/memory) are applied at creation; a wall-clock
 * timeout is the caller's responsibility (see `run-coder.ts`).
 */
export class CoderSandbox implements Sandbox {
  private readonly docker: DockerLike;
  private container: DockerContainerLike | null = null;

  constructor(private readonly options: SandboxOptions) {
    this.docker =
      options.docker ??
      (new Docker(options.dockerHost ? { host: options.dockerHost } : undefined) as DockerLike);
  }

  async start(): Promise<void> {
    this.container = await this.docker.createContainer({
      Image: this.options.image,
      Tty: false,
      NetworkingConfig: {
        EndpointsConfig: { [this.options.network]: {} },
      },
      // Issue #84 live-verification fix: curl/git (via git-remote-http) deliberately ignores the
      // uppercase `HTTP_PROXY` variable for plain-HTTP requests — a long-standing mitigation for
      // the "httpoxy" CGI vulnerability class — and only honors lowercase `http_proxy`. Only
      // `HTTPS_PROXY` has no such ambiguity and was already honored for TLS clone/push targets
      // (github.com, a GitLab/Gitea instance over HTTPS), which is why this went unverified until
      // a real HTTP-scheme SCM host (a self-hosted Gitea instance in this issue's live-daemon
      // verification) was actually cloned through the sandbox: the clone connected directly and
      // failed, since the sandbox network has no route to the outside world without the proxy.
      // Setting both cases covers every git transport, matching how a real deployment's SCM host
      // may be plain-HTTP (an internal Gitea/GitLab instance without its own TLS termination).
      Env: this.options.httpsProxy
        ? [
            `HTTPS_PROXY=${this.options.httpsProxy}`,
            `HTTP_PROXY=${this.options.httpsProxy}`,
            `https_proxy=${this.options.httpsProxy}`,
            `http_proxy=${this.options.httpsProxy}`,
          ]
        : [],
      HostConfig: {
        NetworkMode: this.options.network,
        ReadonlyRootfs: true,
        // /workspace must be writable — it's where workspace.ts clones/writes/commits the repo
        // (HIGH-1 code-review fix: ReadonlyRootfs previously left /workspace under the read-only
        // root with no writable mount, so every real sandbox run would fail at clone/write time
        // despite passing against the fake-Docker unit tests). A tmpfs (not a bind mount or named
        // volume) is deliberate: nothing needs to persist past container removal, and this avoids
        // host-path/ownership complexity for a non-root container user.
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,size=256m',
          '/workspace': 'rw,nosuid,size=2g,uid=10001,gid=10001',
        },
        CapDrop: ['ALL'],
        Privileged: false,
        NanoCpus: this.options.cpus ? Math.round(this.options.cpus * 1e9) : undefined,
        Memory: this.options.memoryBytes,
      },
      // Keep the container alive; individual commands run via `docker exec`.
      Cmd: ['sleep', 'infinity'],
    });
    await this.container.start();
  }

  async run(
    cmd: string,
    args: readonly string[],
    opts: { cwd?: string; env?: Readonly<Record<string, string>> } = {},
  ): Promise<CommandResult> {
    if (!this.container) throw new Error('CoderSandbox.run called before start()');

    const env = opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined;
    const exec = await this.container.exec({
      Cmd: [cmd, ...args],
      WorkingDir: opts.cwd,
      Env: env,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    const { stdout, stderr } = await collectDemuxed(stream);
    const { ExitCode } = await exec.inspect();
    return { stdout, stderr, exitCode: ExitCode ?? 0 };
  }

  async remove(): Promise<void> {
    if (!this.container) return;
    await this.container.remove({ force: true });
    this.container = null;
  }
}

function collectDemuxed(
  stream: NodeJS.ReadableStream,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      // Docker's exec stream multiplexes stdout/stderr with an 8-byte header per frame
      // (byte 0 = stream type: 1=stdout, 2=stderr; bytes 4-7 = big-endian payload length).
      let stdout = '';
      let stderr = '';
      const buf = Buffer.concat(chunks);
      let offset = 0;
      while (offset + 8 <= buf.length) {
        const streamType = buf.readUInt8(offset);
        const length = buf.readUInt32BE(offset + 4);
        const payload = buf.subarray(offset + 8, offset + 8 + length).toString('utf8');
        if (streamType === 2) stderr += payload;
        else stdout += payload;
        offset += 8 + length;
      }
      resolve({ stdout, stderr });
    });
    stream.on('error', reject);
  });
}
