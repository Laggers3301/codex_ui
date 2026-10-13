#!/usr/bin/env bash
set -euo pipefail
[[ $# == 2 ]] || { echo 'Usage: zt-codex-auth-member.sh <node-id> <member-name>' >&2; exit 2; }
# Authorizes only the network node. Web accounts are created independently on
# this host by create-local-member.mjs; never create accounts on the old host.
exec sudo /usr/local/sbin/codex-zerotier-admin authorize "${1,,}" "$2"
