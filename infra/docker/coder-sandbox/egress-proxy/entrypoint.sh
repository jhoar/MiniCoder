#!/bin/sh
set -e

# CODE_GEN_ALLOWED_HOST is deployment-specific (which LLM provider host coder runs are allowed to
# reach) so it's appended to the baked-in GitHub allow-list at container start rather than at
# image build time.
if [ -n "$CODE_GEN_ALLOWED_HOST" ]; then
  ESCAPED=$(printf '%s' "$CODE_GEN_ALLOWED_HOST" | sed 's/[.[\*^$]/\\&/g')
  echo "^${ESCAPED}\$" >> /etc/tinyproxy/filter.txt
fi

# SCM_ALLOWED_HOST (docs/06 §Phase 18 Stage 6's coder-adapter follow-up): a self-hosted Gitea/
# GitLab deployment's own host, needed because the coder adapter's clone/push happens from inside
# this sandbox and the egress proxy is a default-deny allow-list. Not needed for a GitHub-provider
# deployment — github.com/api.github.com/codeload.github.com/objects.githubusercontent.com are
# already baked into filter.txt. Unverified against a live daemon, like the credential-convention
# fix it accompanies (see run-coder.ts's resolveDefaultCoderAdapterFactory() doc comment).
if [ -n "$SCM_ALLOWED_HOST" ]; then
  ESCAPED=$(printf '%s' "$SCM_ALLOWED_HOST" | sed 's/[.[\*^$]/\\&/g')
  echo "^${ESCAPED}\$" >> /etc/tinyproxy/filter.txt
fi

cp /etc/tinyproxy/tinyproxy.conf.template /etc/tinyproxy/tinyproxy.conf
mkdir -p /var/run/tinyproxy
exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
