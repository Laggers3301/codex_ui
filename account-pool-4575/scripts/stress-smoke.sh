#!/usr/bin/env bash
set -euo pipefail

# Private Tailscale and loopback endpoints must not be sent to the workstation's
# HTTP/SOCKS proxy. Node reads NODE_USE_ENV_PROXY before the JavaScript module
# starts, so this has to be done in a small launcher rather than in the module.
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NODE_USE_ENV_PROXY

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/stress-smoke.mjs" "$@"
