#!/usr/bin/env bash
set -euo pipefail
protected_thread="${1:-}"
[[ "$protected_thread" =~ ^[a-fA-F0-9-]{36}$ ]] || { printf '%s\n' 'Usage: bash schedule-account-pool-restart.sh <current-thread-id> [--restart-ui]'; exit 2; }
shift
for deploy_flag in "$@"; do
  [[ "$deploy_flag" == "--restart-ui" ]] || { printf '%s\n' 'Only --restart-ui is accepted as an optional deployment flag.'; exit 2; }
done
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${CODEX_POOL_NODE_BIN:-$(command -v node)}"
unit_name="codex-pool-deploy-$(date +%s)-$$"
systemd-run --user --collect --unit="$unit_name" \
  -p MemoryMax=256M -p CPUQuota=20% \
  /usr/bin/flock --exclusive --nonblock --no-fork \
  "$app_dir/data/backend/deployment.lock" \
  "$node_bin" "$app_dir/scripts/restart-account-pool.cjs" --after-thread "$protected_thread" "$@"
printf 'Queued deployment: %s; waiting for the current conversation to finish.\n' "$unit_name"
