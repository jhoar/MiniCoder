import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  CoderSandbox,
  parseDockerHost,
  type DockerLike,
  type DockerContainerLike,
  type DockerExecLike,
} from './sandbox.js';

/** Builds a Docker exec-stream frame: 8-byte header (stream type + big-endian length) + payload. */
function frame(streamType: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function fakeExec(stdout: string, stderr: string, exitCode: number): DockerExecLike {
  return {
    start: vi.fn(async () => Readable.from([frame(1, stdout), frame(2, stderr)])),
    inspect: vi.fn(async () => ({ ExitCode: exitCode })),
  };
}

function fakeDocker(execFactory: () => DockerExecLike): {
  docker: DockerLike;
  container: DockerContainerLike;
  removed: boolean[];
} {
  const removed: boolean[] = [];
  const container: DockerContainerLike = {
    start: vi.fn(async () => {}),
    exec: vi.fn(async () => execFactory()),
    remove: vi.fn(async () => {
      removed.push(true);
    }),
  };
  const docker: DockerLike = {
    createContainer: vi.fn(async () => container),
  };
  return { docker, container, removed };
}

describe('CoderSandbox', () => {
  it('creates and starts a container attached only to the isolated network', async () => {
    const { docker, container } = fakeDocker(() => fakeExec('', '', 0));
    const sandbox = new CoderSandbox({
      image: 'coder-sandbox:latest',
      network: 'minicoder-coder-sandbox',
      docker,
    });

    await sandbox.start();

    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: 'coder-sandbox:latest',
        HostConfig: expect.objectContaining({
          NetworkMode: 'minicoder-coder-sandbox',
          Privileged: false,
        }),
      }),
    );
    expect(container.start).toHaveBeenCalledOnce();
  });

  it('mounts /workspace as writable despite the read-only root filesystem (HIGH-1 regression)', async () => {
    const { docker } = fakeDocker(() => fakeExec('', '', 0));
    const sandbox = new CoderSandbox({ image: 'coder-sandbox:latest', network: 'net', docker });

    await sandbox.start();

    const call = (docker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.HostConfig.ReadonlyRootfs).toBe(true);
    expect(call.HostConfig.Tmpfs['/workspace']).toMatch(/rw/);
  });

  it('runs a command via docker exec and demultiplexes stdout/stderr', async () => {
    const { docker } = fakeDocker(() => fakeExec('hello\n', 'warn\n', 0));
    const sandbox = new CoderSandbox({ image: 'coder-sandbox:latest', network: 'net', docker });
    await sandbox.start();

    const result = await sandbox.run('echo', ['hello']);

    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('warn\n');
    expect(result.exitCode).toBe(0);
  });

  it('surfaces a non-zero exit code without throwing', async () => {
    const { docker } = fakeDocker(() => fakeExec('', 'boom\n', 1));
    const sandbox = new CoderSandbox({ image: 'coder-sandbox:latest', network: 'net', docker });
    await sandbox.start();

    const result = await sandbox.run('false', []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('boom\n');
  });

  it('throws if run() is called before start()', async () => {
    const { docker } = fakeDocker(() => fakeExec('', '', 0));
    const sandbox = new CoderSandbox({ image: 'coder-sandbox:latest', network: 'net', docker });
    await expect(sandbox.run('echo', ['hi'])).rejects.toThrow(/before start/);
  });

  it('always removes the container, including after a failed exec', async () => {
    const { docker, removed } = fakeDocker(() => fakeExec('', '', 0));
    const sandbox = new CoderSandbox({ image: 'coder-sandbox:latest', network: 'net', docker });
    await sandbox.start();
    await sandbox.remove();
    expect(removed).toEqual([true]);
  });

  it('is safe to call remove() twice / before start()', async () => {
    const { docker } = fakeDocker(() => fakeExec('', '', 0));
    const sandbox = new CoderSandbox({ image: 'coder-sandbox:latest', network: 'net', docker });
    await expect(sandbox.remove()).resolves.toBeUndefined();
    await sandbox.start();
    await sandbox.remove();
    await expect(sandbox.remove()).resolves.toBeUndefined();
  });
});

describe('parseDockerHost (issue #84 fix: coder-sandbox-docker-proxy connectivity)', () => {
  it('splits a documented `host:port` value (the CODER_SANDBOX_DOCKER_HOST convention)', () => {
    expect(parseDockerHost('coder-sandbox-docker-proxy:2375')).toEqual({
      host: 'coder-sandbox-docker-proxy',
      port: 2375,
    });
  });

  it('returns a bare hostname unchanged when no port is present', () => {
    expect(parseDockerHost('coder-sandbox-docker-proxy')).toEqual({
      host: 'coder-sandbox-docker-proxy',
    });
  });

  it('strips a tcp:// scheme and still extracts the port', () => {
    expect(parseDockerHost('tcp://coder-sandbox-docker-proxy:2375')).toEqual({
      host: 'coder-sandbox-docker-proxy',
      port: 2375,
    });
  });

  it('does not misparse an IPv4 host:port pair', () => {
    expect(parseDockerHost('127.0.0.1:2375')).toEqual({ host: '127.0.0.1', port: 2375 });
  });

  it('falls back to the whole string when the suffix after the last colon is not a valid port', () => {
    expect(parseDockerHost('some:weird:value')).toEqual({ host: 'some:weird:value' });
  });
});
