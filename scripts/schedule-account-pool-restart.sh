#!/usr/bin/env bash
set -euo pipefail
protected_thread="${1:-}"
[[ "$protected_thread" =~ ^[a-fA-F0-9-]{36}$ ]] || { printf '%s\n' 'Usage: bash schedule-account-pool-restart.sh <current-thread-id> [--restart-ui]'; exit 2; }
shift
verify_next=false
for deploy_flag in "$@"; do
  if [[ "$verify_next" == true ]]; then
    [[ "$deploy_flag" =~ ^[a-fA-F0-9-]{36}$ ]] || exit 2
    verify_next=false
  elif [[ "$deploy_flag" == "--verify-authorization" ]]; then
    verify_next=true
  else
    [[ "$deploy_flag" == "--restart-ui" || "$deploy_flag" == "--all-idle" ]] || { printf '%s\n' 'Unsupported deployment flag.'; exit 2; }
  fi
done
[[ "$verify_next" == false ]] || exit 2
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${CODEX_POOL_NODE_BIN:-$(command -v node)}"
unit_name="codex-pool-deploy-$(date +%s)-$$"
systemd-run --user --collect --unit="$unit_name" \
  -p MemoryMax=256M -p CPUQuota=20% \
  /usr/bin/flock --exclusive --nonblock --no-fork \
  "$app_dir/data/backend/deployment.lock" \
  "$node_bin" "$app_dir/scripts/restart-account-pool.cjs" --after-thread "$protected_thread" "$@"
printf 'Queued deployment: %s; waiting for the current conversation to finish.\n' "$unit_name"
