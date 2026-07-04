# MiniCoder — coder sandbox egress allow-list proxy (docs/07-security-and-secrets.md §6).
#
# The *only* egress path out of the isolated `minicoder-coder-sandbox` network (see
# ../../../docker-compose.coder-sandbox.yml): dual-homed on that internal network and on
# `minicoder-coder-egress` (real internet access), forwarding only to the allow-listed hosts in
# filter.txt. tinyproxy is a well-known, minimal Alpine package — deliberately not a bespoke proxy
# implementation for a security-critical control.

FROM alpine:3.19

RUN apk add --no-cache tinyproxy

COPY tinyproxy.conf.template /etc/tinyproxy/tinyproxy.conf.template
COPY filter.txt /etc/tinyproxy/filter.txt
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8888
ENTRYPOINT ["/entrypoint.sh"]
