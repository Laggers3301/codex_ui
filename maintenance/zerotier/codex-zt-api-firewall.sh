#!/usr/bin/env bash
set -euo pipefail
# Only the new management TCP port is protected. Overlay UDP and every other
# application port retain their original policy.
for tool in /usr/sbin/iptables /usr/sbin/ip6tables; do
  if ! "$tool" -w 5 -C INPUT ! -i lo -p tcp --dport 19993 -j REJECT --reject-with tcp-reset 2>/dev/null; then
    "$tool" -w 5 -I INPUT 1 ! -i lo -p tcp --dport 19993 -j REJECT --reject-with tcp-reset
  fi
done
