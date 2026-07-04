#!/bin/sh
set -e

# CODE_GEN_ALLOWED_HOST is deployment-specific (which LLM provider host coder runs are allowed to
# reach) so it's appended to the baked-in GitHub allow-list at container start rather than at
# image build time.
if [ -n "$CODE_GEN_ALLOWED_HOST" ]; then
  ESCAPED=$(printf '%s' "$CODE_GEN_ALLOWED_HOST" | sed 's/[.[\*^$]/\\&/g')
  echo "^${ESCAPED}\$" >> /etc/tinyproxy/filter.txt
fi

cp /etc/tinyproxy/tinyproxy.conf.template /etc/tinyproxy/tinyproxy.conf
mkdir -p /var/run/tinyproxy
exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
