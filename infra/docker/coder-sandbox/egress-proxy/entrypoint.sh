#!/bin/sh
set -e

# tinyproxy's default filter mode matches only the bare hostname of a request, with any :port
# suffix already stripped before comparison — confirmed against a real container's own denial log
# ("Proxying refused on filtered domain \"host.docker.internal\"" for a request to
# host.docker.internal:3300; live debugging session, issue tracked in CLAUDE.md's Local Quickstart
# Defaults closed-gap notes). A caller-supplied CODE_GEN_ALLOWED_HOST/SCM_ALLOWED_HOST that
# includes a :port (a reasonable thing to write, since both env vars are documented elsewhere as
# "host[:port]") would otherwise build a filter.txt entry anchored on the port too
# (`^host\.docker\.internal:3300$`), which can never match tinyproxy's portless comparison string —
# a silent, permanent 403 with no indication the port was the problem. Stripping it here makes the
# filter robust regardless of whether the caller included one.
strip_port() {
  printf '%s' "$1" | sed 's/:[0-9]*$//'
}

# CODE_GEN_ALLOWED_HOST is deployment-specific (which LLM provider host coder runs are allowed to
# reach) so it's appended to the baked-in GitHub allow-list at container start rather than at
# image build time.
if [ -n "$CODE_GEN_ALLOWED_HOST" ]; then
  HOST_ONLY=$(strip_port "$CODE_GEN_ALLOWED_HOST")
  ESCAPED=$(printf '%s' "$HOST_ONLY" | sed 's/[.[\*^$]/\\&/g')
  echo "^${ESCAPED}\$" >> /etc/tinyproxy/filter.txt
fi

# SCM_ALLOWED_HOST (docs/06 §Phase 18 Stage 6's coder-adapter follow-up): a self-hosted Gitea/
# GitLab deployment's own host, needed because the coder adapter's clone/push happens from inside
# this sandbox and the egress proxy is a default-deny allow-list. Not needed for a GitHub-provider
# deployment — github.com/api.github.com/codeload.github.com/objects.githubusercontent.com are
# already baked into filter.txt. Live-daemon-verified as of issue #84 (see run-coder.ts's
# resolveDefaultCoderAdapterFactory() doc comment and
# packages/adapters-coder/src/sandbox-live.integration.test.ts).
if [ -n "$SCM_ALLOWED_HOST" ]; then
  HOST_ONLY=$(strip_port "$SCM_ALLOWED_HOST")
  ESCAPED=$(printf '%s' "$HOST_ONLY" | sed 's/[.[\*^$]/\\&/g')
  echo "^${ESCAPED}\$" >> /etc/tinyproxy/filter.txt
fi

cp /etc/tinyproxy/tinyproxy.conf.template /etc/tinyproxy/tinyproxy.conf
mkdir -p /var/run/tinyproxy
exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
