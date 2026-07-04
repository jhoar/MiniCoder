# MiniCoder — pre-baked Coder sandbox image (Phase 9, docs/07-security-and-secrets.md §6).
#
# One ephemeral container per coder run (packages/adapters-coder/src/sandbox.ts spawns it via
# dockerode against coder-sandbox-docker-proxy — see ../../docker-compose.coder-sandbox.yml).
# Node.js + pnpm + git preinstalled so a run never needs to reach a package registry directly for
# its own tooling; project dependency installs are satisfied from the read-only-bind-mounted pnpm
# store (coder-sandbox-pnpm-store) or proxied through the egress allow-list.
#
# Runs as a non-root user, with HostConfig.ReadonlyRootfs / CapDrop: ['ALL'] / Privileged: false
# applied at container-creation time (sandbox.ts), not here — this image only needs to be usable
# under those constraints (writable /workspace and /tmp, no setup step that requires root after
# the build completes).

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@9 --activate

# Matches the uid/gid `docker exec`'d commands run as once HostConfig.User is set by sandbox.ts;
# /workspace is the writable scratch mount `CoderSandbox`/`workspace.ts` clone into.
RUN useradd --create-home --uid 10001 coder \
  && mkdir -p /workspace \
  && chown -R coder:coder /workspace

USER coder
WORKDIR /workspace

# No ENTRYPOINT/CMD here — sandbox.ts starts the container with `sleep infinity` and drives all
# actual work via `docker exec` (see CoderSandbox.run()), so retries/cancellation don't depend on
# a single foreground process's lifecycle.
